(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const screens = ['landingScreen', 'lobbyScreen', 'gameScreen'];
  const avatars = ['🦁','🐯','🐼','🦊','🐸','🐵','🐨','🐙'];
  const colors = ['red', 'blue', 'yellow', 'green'];
  const colorNames = { red: 'Red', blue: 'Blue', yellow: 'Yellow', green: 'Green' };
  const starts = { red: 0, blue: 13, yellow: 26, green: 39 };
  const homeEntrances = { red: 51, blue: 12, yellow: 25, green: 38 };
  const safeGlobal = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
  const roomFromUrl = new URLSearchParams(location.search).get('room');

  const basePath = [
    [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],
    [1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],[8,14],
    [8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],
    [13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0]
  ];
  const homePath = {
    red: [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
    blue: [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
    yellow: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
    green: [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]]
  };
  const yardCells = {
    red: [[1,1],[1,4],[4,1],[4,4]],
    blue: [[1,10],[1,13],[4,10],[4,13]],
    yellow: [[10,10],[10,13],[13,10],[13,13]],
    green: [[10,1],[10,4],[13,1],[13,4]]
  };

  let selectedAvatar = Number(localStorage.getItem('ludo.avatar') || 0);
  let nickname = localStorage.getItem('ludo.nickname') || '';
  let peer = null;
  let myId = null;
  let hostId = null;
  let isHost = false;
  let profile = null;
  let conns = new Map();
  let playerOrder = [];
  let localStream = null;
  let audioCalls = new Map();
  let audioEls = new Map();
  let analysers = new Map();
  let muted = false;
  let pendingLaunch = false;
  let lastTick = 0;
  let autoRollTimer = null;
  let botTurnTimer = null;

  let state = initialState();

  function initialState() {
    return {
      phase: 'landing',
      hostId: null,
      players: [],
      started: false,
      currentTurn: 0,
      dice: null,
      rolled: false,
      turnStartedAt: Date.now(),
      tokens: {},
      log: [],
      winnerId: null,
      lastMove: null
    };
  }

  function logLine(text) {
    state.log.unshift({ text, at: new Date().toLocaleTimeString() });
    state.log = state.log.slice(0, 12);
  }

  function showScreen(id) {
    screens.forEach((s) => $(s).classList.toggle('active', s === id));
  }

  function setStatus(text, online = false) {
    $('connectionStatus').textContent = text;
    $('connectionStatus').classList.toggle('online', online);
  }

  function initLanding() {
    $('nickname').value = nickname;
    $('primaryAction').textContent = roomFromUrl ? 'Join Lobby ›' : 'Play Online ›';
    $('avatarCarousel').innerHTML = avatars.map((a, i) => `<button type="button" class="avatar-choice ${i === selectedAvatar ? 'selected' : ''}" data-avatar="${i}" aria-label="Avatar ${i + 1}">${a}</button>`).join('');
    $('avatarCarousel').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-avatar]');
      if (!btn) return;
      selectedAvatar = Number(btn.dataset.avatar);
      localStorage.setItem('ludo.avatar', String(selectedAvatar));
      initLanding();
    });
    $('nickname').focus();
    $('profileForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = ($('nickname').value.trim().slice(0, 12) || 'Player');
      if (!name) return toast('Please enter a nickname.');
      nickname = name;
      localStorage.setItem('ludo.nickname', nickname);
      profile = { nickname, avatar: selectedAvatar };
      pendingLaunch = true;
      showMicModal();
    });
    $('offlineDemoBtn').addEventListener('click', () => startOfflineDemo());
    $('profileBtn')?.addEventListener('click', () => toast(`Profile saved locally as ${$('nickname').value.trim() || localStorage.getItem('ludo.nickname') || 'Player'}.`));
    $('settingsBtn')?.addEventListener('click', () => toast('Settings: sound, voice mute, and volume controls are available in-game.'));
  }

  function showMicModal() {
    $('modal').classList.remove('hidden');
  }

  function hideMicModal() {
    $('modal').classList.add('hidden');
  }

  $('modalAllowBtn').addEventListener('click', async () => {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    } catch (err) {
      toast('Mic blocked. Continuing muted.');
      console.warn('Microphone unavailable:', err);
    }
    hideMicModal();
    if (pendingLaunch) startNetworkFlow();
  });
  $('modalSkipBtn').addEventListener('click', () => {
    hideMicModal();
    if (pendingLaunch) startNetworkFlow();
  });

  function startNetworkFlow() {
    pendingLaunch = false;
    if (typeof Peer === 'undefined') {
      toast('PeerJS could not load. Use Offline Demo or serve with internet access.');
      return;
    }
    if (roomFromUrl) joinRoom(roomFromUrl);
    else createRoom();
  }

  function createPeer(id) {
    peer = new Peer(id || undefined, { debug: 1 });
    peer.on('open', (id) => {
      myId = id;
      setStatus('Connected', true);
      if (!hostId) hostId = id;
      if (isHost) becomeHost(id);
    });
    peer.on('connection', (conn) => setupConn(conn));
    peer.on('call', (call) => {
      call.answer(localStream || undefined);
      call.on('stream', (stream) => attachRemoteAudio(call.peer, stream));
      audioCalls.set(call.peer, call);
    });
    peer.on('error', (err) => {
      console.error(err);
      toast(err.type === 'unavailable-id' ? 'Room ID collision. Refresh to make a new room.' : `Connection issue: ${err.type || err.message}`);
      setStatus('Connection issue', false);
    });
  }

  function createRoom() {
    isHost = true;
    const id = `ludo-${Math.random().toString(36).slice(2, 8)}`;
    hostId = id;
    createPeer(id);
  }

  function joinRoom(id) {
    isHost = false;
    hostId = id;
    createPeer();
    const wait = setInterval(() => {
      if (!myId || !peer) return;
      clearInterval(wait);
      const conn = peer.connect(hostId, { reliable: true });
      setupConn(conn);
    }, 120);
  }

  function becomeHost(id) {
    state = initialState();
    state.phase = 'lobby';
    state.hostId = id;
    state.players = [{ id, nickname: profile.nickname, avatar: profile.avatar, color: 'red', online: true, isHost: true }];
    playerOrder = [id];
    state.tokens[id] = Array.from({ length: 4 }, () => ({ pos: -1, finished: false }));
    hostId = id;
    history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(id)}`);
    renderLobby();
    showScreen('lobbyScreen');
    broadcast({ type: 'STATE', state });
    callAllPeers();
  }

  function setupConn(conn) {
    conn.on('open', () => {
      conns.set(conn.peer, conn);
      if (!isHost) send(conn, { type: 'JOIN_REQUEST', profile, peerId: myId });
      if (localStream) callPeer(conn.peer);
    });
    conn.on('data', (msg) => handleMessage(conn.peer, msg));
    conn.on('close', () => handlePeerClose(conn.peer));
    conn.on('error', () => handlePeerClose(conn.peer));
  }

  function send(conn, msg) {
    if (conn && conn.open) conn.send(msg);
  }

  function sendTo(peerId, msg) {
    send(conns.get(peerId), msg);
  }

  function broadcast(msg) {
    for (const conn of conns.values()) send(conn, msg);
  }

  function handleMessage(from, msg) {
    if (!msg || !msg.type) return;
    if (isHost) handleHostMessage(from, msg);
    else handleClientMessage(from, msg);
  }

  function handleHostMessage(from, msg) {
    if (msg.type === 'JOIN_REQUEST') {
      if (state.players.length >= 4) {
        sendTo(from, { type: 'ROOM_FULL' });
        conns.get(from)?.close();
        return;
      }
      if (!state.players.find((p) => p.id === from)) {
        const color = colors[state.players.length];
        state.players.push({ id: from, nickname: msg.profile.nickname, avatar: msg.profile.avatar, color, online: true, isHost: false });
        playerOrder = state.players.map((p) => p.id);
        state.tokens[from] = Array.from({ length: 4 }, () => ({ pos: -1, finished: false }));
        logLine(`${msg.profile.nickname} joined as ${colorNames[color]}.`);
        connectEveryoneToNewPeer(from);
      }
      sync();
    }
    if (msg.type === 'ROLL_REQUEST') hostRoll(from);
    if (msg.type === 'MOVE_REQUEST') hostMove(from, msg.tokenIndex);
    if (msg.type === 'PING') sendTo(from, { type: 'PONG', t: msg.t });
  }

  function handleClientMessage(_from, msg) {
    if (msg.type === 'STATE') {
      state = msg.state;
      hostId = state.hostId;
      renderAll();
    }
    if (msg.type === 'ROOM_FULL') {
      showScreen('landingScreen');
      toast('Sorry, this room is full (4/4). Create your own room instead.');
    }
    if (msg.type === 'PEER_LIST') connectToPeerList(msg.peers || []);
    if (msg.type === 'HOST_MIGRATION') migrateHost(msg.newHostId);
  }

  function sync() {
    broadcast({ type: 'STATE', state });
    renderAll();
  }

  function connectEveryoneToNewPeer(newPeerId) {
    const peers = state.players.map((p) => p.id);
    broadcast({ type: 'PEER_LIST', peers });
    sendTo(newPeerId, { type: 'PEER_LIST', peers });
  }

  function connectToPeerList(peers) {
    peers.filter((id) => id !== myId && id !== hostId && !conns.has(id)).forEach((id) => {
      const c = peer.connect(id, { reliable: true });
      setupConn(c);
    });
    setTimeout(callAllPeers, 400);
  }

  function handlePeerClose(peerId) {
    conns.delete(peerId);
    if (isHost) {
      const p = state.players.find((x) => x.id === peerId);
      if (p) {
        p.online = false;
        logLine(`${p.nickname} disconnected. Waiting 30 seconds for reconnection.`);
        sync();
      }
    } else if (peerId === hostId) {
      const ids = state.players.map((p) => p.id);
      const newHost = ids.find((id) => id !== hostId);
      if (newHost) migrateHost(newHost);
    }
  }

  function migrateHost(newHostId) {
    if (myId === newHostId) {
      isHost = true;
      hostId = myId;
      state.hostId = myId;
      state.players.forEach((p) => { p.isHost = p.id === myId; });
      logLine('Host migrated to this browser.');
      broadcast({ type: 'HOST_MIGRATION', newHostId: myId });
      sync();
    } else {
      hostId = newHostId;
      if (!conns.has(hostId) && peer) setupConn(peer.connect(hostId, { reliable: true }));
      toast('Host changed. Reconnecting...');
    }
  }

  function renderAll() {
    if (state.phase === 'lobby') renderLobby();
    if (state.phase === 'game') renderGame();
  }

  function renderLobby() {
    showScreen('lobbyScreen');
    const roomUrl = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.hostId || hostId || '')}`;
    $('inviteLink').value = roomUrl;
    $('roomRoleText').textContent = isHost ? 'You are the host. Launch when at least 2 players are ready.' : 'Connected as guest. Waiting for host to launch.';
    const slots = [];
    for (let i = 0; i < 4; i++) {
      const p = state.players[i];
      if (p) {
        slots.push(`<div class="player-slot"><span class="ping-dot ${p.online ? '' : 'bad'}"></span><div class="player-avatar">${avatars[p.avatar]}</div><strong>${escapeHtml(p.nickname)}</strong><small>${colorNames[p.color]} ${p.isHost ? '• Host' : ''}</small></div>`);
      } else {
        slots.push('<div class="player-slot empty">Waiting for friend...</div>');
      }
    }
    $('playerSlots').innerHTML = slots.join('');
    $('launchGameBtn').disabled = !(isHost && state.players.length >= 2);
  }

  $('copyInviteBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('inviteLink').value);
      $('copyInviteBtn').textContent = '✓ Link Copied!';
      setTimeout(() => $('copyInviteBtn').textContent = 'Copy Invite Link', 2000);
    } catch {
      $('inviteLink').select();
      document.execCommand('copy');
    }
  });
  $('launchGameBtn').addEventListener('click', () => {
    if (!isHost || state.players.length < 2) return;
    startGame();
  });
  $('leaveRoomBtn').addEventListener('click', () => location.href = location.pathname);

  function startGame() {
    state.phase = 'game';
    state.started = true;
    state.currentTurn = 0;
    state.dice = null;
    state.rolled = false;
    state.turnStartedAt = Date.now();
    logLine('Game launched. Red starts.');
    sync();
  }

  function hostRoll(from, forced = false) {
    if (state.winnerId || !isCurrentPlayer(from) || state.rolled) return;
    state.dice = 1 + Math.floor(Math.random() * 6);
    state.rolled = true;
    state.lastMove = { type: 'roll', playerId: from, dice: state.dice, at: Date.now() };
    const p = getPlayer(from);
    logLine(`${p.nickname} rolled ${state.dice}${forced ? ' (auto)' : ''}.`);
    toast(`${p.nickname} rolled ${state.dice}`);
    const moves = validMoves(from, state.dice);
    if (!moves.length) {
      logLine(`${p.nickname} has no legal moves.`);
      setTimeout(nextTurn, 900);
    } else if (isBotPlayer(p)) {
      clearTimeout(botTurnTimer);
      botTurnTimer = setTimeout(() => botChooseMove(from), 850);
    }
    sync();
  }

  function botChooseMove(playerId) {
    if (!isHost || state.winnerId || !isCurrentPlayer(playerId) || !state.rolled) return;
    const moves = validMoves(playerId, state.dice);
    if (!moves.length) return;
    const chosen = chooseBestMove(playerId, moves, state.dice);
    hostMove(playerId, chosen);
  }

  function chooseBestMove(playerId, moves, dice) {
    const p = getPlayer(playerId);
    const tokens = state.tokens[playerId];
    const captureMove = moves.find((idx) => {
      const pos = tokens[idx].pos === -1 ? 0 : tokens[idx].pos + dice;
      if (pos < 0 || pos > 51) return false;
      const global = (starts[p.color] + pos) % 52;
      if (safeGlobal.has(global)) return false;
      return state.players.some((op) => op.id !== playerId && (state.tokens[op.id] || []).some((t) => t.pos >= 0 && t.pos <= 51 && (starts[op.color] + t.pos) % 52 === global));
    });
    if (captureMove !== undefined) return captureMove;
    const finishMove = moves.find((idx) => (tokens[idx].pos === -1 ? 0 : tokens[idx].pos + dice) >= 57);
    if (finishMove !== undefined) return finishMove;
    const enterMove = moves.find((idx) => tokens[idx].pos === -1);
    if (enterMove !== undefined) return enterMove;
    return moves.slice().sort((a, b) => tokens[b].pos - tokens[a].pos)[0];
  }

  function isBotPlayer(p) {
    return Boolean(p && (p.bot || String(p.id).startsWith('bot-')));
  }

  function hostMove(from, tokenIndex) {
    if (state.winnerId || !isCurrentPlayer(from) || !state.rolled || state.dice == null) return;
    const moves = validMoves(from, state.dice);
    if (!moves.includes(tokenIndex)) return;
    const token = state.tokens[from][tokenIndex];
    const fromPos = token.pos;
    if (token.pos === -1) token.pos = 0;
    else token.pos += state.dice;
    if (token.pos >= 57) token.finished = true;
    const p = getPlayer(from);
    state.lastMove = { type: 'move', playerId: from, tokenIndex, fromPos, toPos: token.pos, at: Date.now() };
    logLine(`${p.nickname} moved token ${tokenIndex + 1}.`);
    toast(`${p.nickname} moved token ${tokenIndex + 1}`);
    captureAt(from, token.pos);
    if (state.tokens[from].every((t) => t.finished)) {
      state.winnerId = from;
      logLine(`${p.nickname} wins the match!`);
      toast(`🏆 ${p.nickname} wins!`);
      state.rolled = true;
      sync();
      return;
    }
    if (state.dice === 6) {
      state.dice = null;
      state.rolled = false;
      state.turnStartedAt = Date.now();
      logLine(`${p.nickname} gets another turn.`);
    } else {
      nextTurn();
      return;
    }
    sync();
  }

  function nextTurn() {
    if (state.winnerId) return sync();
    const activePlayers = state.players.filter((p) => p.online !== false);
    if (!activePlayers.length) return;
    do {
      state.currentTurn = (state.currentTurn + 1) % state.players.length;
    } while (state.players[state.currentTurn]?.online === false);
    state.dice = null;
    state.rolled = false;
    state.turnStartedAt = Date.now();
    const p = state.players[state.currentTurn];
    if (p) logLine(`${p.nickname}'s turn.`);
    sync();
  }

  function isCurrentPlayer(id) {
    return state.players[state.currentTurn]?.id === id;
  }

  function getPlayer(id) {
    return state.players.find((p) => p.id === id);
  }

  function validMoves(playerId, dice) {
    const tokens = state.tokens[playerId] || [];
    return tokens.flatMap((t, i) => {
      if (t.finished) return [];
      if (t.pos === -1) return dice === 6 ? [i] : [];
      if (t.pos + dice <= 57) return [i];
      return [];
    });
  }

  function captureAt(moverId, moverPos) {
    if (moverPos < 0 || moverPos > 51) return;
    const mover = getPlayer(moverId);
    const global = (starts[mover.color] + moverPos) % 52;
    if (safeGlobal.has(global)) return;
    for (const p of state.players) {
      if (p.id === moverId) continue;
      (state.tokens[p.id] || []).forEach((t, i) => {
        if (t.pos < 0 || t.pos > 51) return;
        const theirGlobal = (starts[p.color] + t.pos) % 52;
        if (theirGlobal === global) {
          t.pos = -1;
          logLine(`${mover.nickname} captured ${p.nickname}'s token ${i + 1}.`);
          toast(`💥 ${mover.nickname} captured ${p.nickname}!`);
        }
      });
    }
  }

  function renderGame() {
    showScreen('gameScreen');
    renderBoard();
    renderPanels();
    renderVoice();
    manageAutoRoll();
  }

  function renderBoard() {
    const board = $('board');
    board.innerHTML = '';
    const cells = Array.from({ length: 15 }, () => Array.from({ length: 15 }, () => ({ cls: 'cell', html: '' })));
    paintHome(cells, 'red', 0, 0);
    paintHome(cells, 'blue', 0, 9);
    paintHome(cells, 'green', 9, 0);
    paintHome(cells, 'yellow', 9, 9);
    basePath.forEach(([r, c], i) => { cells[r][c].cls += ' path'; if (safeGlobal.has(i)) cells[r][c].cls += ' safe'; });
    Object.entries(homePath).forEach(([color, coords]) => coords.forEach(([r,c]) => cells[r][c].cls += ` finish-${color}`));
    for (let r = 6; r <= 8; r++) for (let c = 6; c <= 8; c++) cells[r][c].cls += ' center';

    const tokenPlacements = collectTokenPlacements();
    tokenPlacements.forEach((items, key) => {
      const [r, c] = key.split(',').map(Number);
      cells[r][c].html += items.map((it, idx) => tokenHtml(it, offsetFor(idx, items.length))).join('');
    });

    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const div = document.createElement('div');
        div.className = cells[r][c].cls;
        div.dataset.r = r; div.dataset.c = c;
        div.innerHTML = cells[r][c].html;
        board.appendChild(div);
      }
    }
    board.querySelectorAll('[data-token]').forEach((el) => el.addEventListener('click', () => requestMove(Number(el.dataset.token))));
  }

  function paintHome(cells, color, r0, c0) {
    for (let r = r0; r < r0 + 6; r++) for (let c = c0; c < c0 + 6; c++) cells[r][c].cls += ` home-${color}`;
    (yardCells[color] || []).forEach(([r, c]) => {
      cells[r][c].cls += ` yard-spot yard-${color}`;
    });
  }

  function collectTokenPlacements() {
    const map = new Map();
    const valid = state.rolled && isCurrentPlayer(myId) ? validMoves(myId, state.dice) : [];
    state.players.forEach((p) => {
      (state.tokens[p.id] || []).forEach((t, i) => {
        const coord = coordForToken(p.color, t, i);
        const key = coord.join(',');
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ player: p, index: i, valid: p.id === myId && valid.includes(i) });
      });
    });
    return map;
  }

  function coordForToken(color, token, index) {
    if (token.pos === -1) return yardCells[color][index];
    if (token.pos >= 52) return homePath[color][Math.min(5, token.pos - 52)];
    return basePath[(starts[color] + token.pos) % 52];
  }

  function tokenHtml(item, offset) {
    const validCls = item.valid ? ' valid' : '';
    return `<button class="token ${item.player.color}${validCls}" data-token="${item.index}" title="${escapeHtml(item.player.nickname)} token ${item.index + 1}" style="--tx:${offset.x}%;--ty:${offset.y}%">${item.index + 1}</button>`;
  }

  function offsetFor(idx, total) {
    if (total === 1) return { x: 0, y: 0 };
    const spread = 24;
    const positions = [{x:-spread,y:-spread},{x:spread,y:-spread},{x:-spread,y:spread},{x:spread,y:spread}];
    return positions[idx % positions.length];
  }

  function renderPanels() {
    const turn = state.players[state.currentTurn];
    const winner = state.winnerId ? getPlayer(state.winnerId) : null;
    $('turnTitle').textContent = winner ? `${winner.nickname} wins!` : (turn ? `${turn.nickname}'s turn` : 'Waiting...');
    const diceFaces = { 1: '⚀', 2: '⚁', 3: '⚂', 4: '⚃', 5: '⚄', 6: '⚅' };
    $('diceValue').textContent = state.dice ? diceFaces[state.dice] : '✦';
    $('diceHint').textContent = winner ? 'Game over' : (state.rolled ? 'Move token' : (turn?.id === myId ? 'Your roll' : (isBotPlayer(turn) ? 'Bot thinking' : 'Waiting')));
    $('diceBox').classList.toggle('active', !winner && turn?.id === myId && !state.rolled);
    $('diceBox').classList.toggle('rolled', Boolean(state.dice));
    $('rollDiceBtn').disabled = Boolean(winner) || !(turn?.id === myId && !state.rolled);
    $('rollDiceBtn').textContent = winner ? 'Game Finished' : 'Roll Dice';
    $('gameLog').innerHTML = state.log.map((l) => `<div><strong>${l.at}</strong> ${escapeHtml(l.text)}</div>`).join('');
    const valid = state.rolled && isCurrentPlayer(myId) ? validMoves(myId, state.dice) : [];
    $('gamePlayers').innerHTML = state.players.map((p, i) => {
      const finished = (state.tokens[p.id] || []).filter((t) => t.finished).length;
      const active = turn?.id === p.id && !winner;
      const win = winner?.id === p.id;
      return `<div class="game-player-card ${p.color} pos-${i} ${active ? 'active-turn' : ''} ${win ? 'winner' : ''}"><span class="player-badge-avatar">${avatars[p.avatar]}</span><div><strong>${escapeHtml(p.nickname)}</strong><small>${colorNames[p.color]} • ${finished}/4 home ${p.bot ? '• CPU' : ''}</small></div></div>`;
    }).join('');
  }

  function manageAutoRoll() {
    clearTimeout(autoRollTimer);
    clearTimeout(botTurnTimer);
    const turn = state.players[state.currentTurn];
    if (state.winnerId || !turn) return;
    const elapsed = Date.now() - state.turnStartedAt;
    $('timerBar').firstElementChild.style.width = `${Math.min(100, elapsed / 150)}%`;
    if (isHost && turn && !state.rolled) {
      const delay = isBotPlayer(turn) ? 900 : Math.max(0, 15000 - elapsed);
      autoRollTimer = setTimeout(() => {
        if (!state.rolled && state.players[state.currentTurn]?.id === turn.id) hostRoll(turn.id, isBotPlayer(turn) || true);
      }, delay);
    } else if (isHost && turn && state.rolled && isBotPlayer(turn)) {
      botTurnTimer = setTimeout(() => botChooseMove(turn.id), 750);
    }
    requestAnimationFrame(() => {
      if (state.phase === 'game' && Date.now() - lastTick > 120) {
        lastTick = Date.now();
        const elapsed2 = Date.now() - state.turnStartedAt;
        $('timerBar').firstElementChild.style.width = `${Math.min(100, elapsed2 / 150)}%`;
      }
    });
  }

  $('rollDiceBtn').addEventListener('click', requestRoll);
  $('diceBox').addEventListener('click', requestRoll);
  $('diceBox').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') requestRoll(); });
  function requestRoll() {
    const turn = state.players[state.currentTurn];
    if (state.winnerId || isBotPlayer(turn)) return;
    if (isHost) hostRoll(myId);
    else sendTo(hostId, { type: 'ROLL_REQUEST' });
  }
  function requestMove(tokenIndex) {
    const turn = state.players[state.currentTurn];
    if (state.winnerId || isBotPlayer(turn)) return;
    if (isHost) hostMove(myId, tokenIndex);
    else sendTo(hostId, { type: 'MOVE_REQUEST', tokenIndex });
  }

  function callPeer(peerId) {
    if (!localStream || !peerId || peerId === myId || audioCalls.has(peerId)) return;
    try {
      const call = peer.call(peerId, localStream);
      call.on('stream', (stream) => attachRemoteAudio(peerId, stream));
      audioCalls.set(peerId, call);
    } catch (err) { console.warn('call failed', err); }
  }
  function callAllPeers() {
    Array.from(conns.keys()).forEach(callPeer);
  }
  function attachRemoteAudio(peerId, stream) {
    if (audioEls.has(peerId)) return;
    const audio = $('audioTemplate').content.firstElementChild.cloneNode();
    audio.srcObject = stream;
    audio.volume = 1;
    document.body.appendChild(audio);
    audioEls.set(peerId, audio);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      analysers.set(peerId, analyser);
      monitorVoice();
    } catch (err) { console.warn('analyser failed', err); }
    renderVoice();
  }
  function renderVoice() {
    $('muteBtn').textContent = muted ? 'Unmute Mic' : 'Mute Mic';
    $('voiceList').innerHTML = state.players.map((p) => {
      const isMe = p.id === myId;
      const audio = audioEls.get(p.id);
      return `<div class="voice-card" data-voice="${p.id}"><div class="mini-avatar">${avatars[p.avatar]}</div><div><strong>${escapeHtml(p.nickname)}${isMe ? ' (you)' : ''}</strong><br><small>${audio || isMe ? 'audio ready' : 'no audio stream'}</small>${isMe ? '' : `<input type="range" min="0" max="1" step="0.05" value="${audio?.volume ?? 1}" data-volume="${p.id}">`}</div></div>`;
    }).join('');
    $('voiceList').querySelectorAll('[data-volume]').forEach((range) => {
      range.addEventListener('input', () => { const a = audioEls.get(range.dataset.volume); if (a) a.volume = Number(range.value); });
    });
  }
  $('muteBtn').addEventListener('click', () => {
    muted = !muted;
    if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    renderVoice();
  });
  function monitorVoice() {
    const data = new Uint8Array(64);
    const step = () => {
      analysers.forEach((analyser, peerId) => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        document.querySelector(`[data-voice="${CSS.escape(peerId)}"]`)?.classList.toggle('speaking', avg > 24);
      });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function startOfflineDemo() {
    myId = 'demo-host';
    isHost = true;
    hostId = myId;
    profile = { nickname: $('nickname').value.trim().slice(0, 12) || 'Player', avatar: selectedAvatar };
    state = initialState();
    state.phase = 'game';
    state.hostId = myId;
    state.started = true;
    state.players = [
      { id: myId, nickname: profile.nickname, avatar: profile.avatar, color: 'red', online: true, isHost: true },
      { id: 'bot-blue', nickname: 'Blue CPU', avatar: 1, color: 'blue', online: true, isHost: false, bot: true },
      { id: 'bot-yellow', nickname: 'Yellow CPU', avatar: 5, color: 'yellow', online: true, isHost: false, bot: true },
      { id: 'bot-green', nickname: 'Green CPU', avatar: 4, color: 'green', online: true, isHost: false, bot: true }
    ];
    state.players.forEach((p) => state.tokens[p.id] = Array.from({ length: 4 }, () => ({ pos: -1, finished: false })));
    state.log = [{ text: 'Offline 4-player match launched. You play red; CPUs play blue, yellow, and green.', at: new Date().toLocaleTimeString() }];
    setStatus('Offline demo', true);
    showScreen('gameScreen');
    renderGame();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>'"]/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
  }
  function toast(msg) {
    let el = (document.querySelector('#gameScreen.active #toast')) || $('globalToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'globalToast';
      el.className = 'toast global-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2400);
  }

  window.ludoToast = toast;

  document.addEventListener('click', (e) => {
    if (e.target?.id === 'profileBtn') toast(`Profile saved locally as ${$('nickname')?.value.trim() || localStorage.getItem('ludo.nickname') || 'Player'}.`);
    if (e.target?.id === 'settingsBtn') toast('Settings: voice mute and per-player volume controls are available in-game.');
  });

  initLanding();
  showScreen('landingScreen');
  setStatus('Ready');
})();
