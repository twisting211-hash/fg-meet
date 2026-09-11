(function () {
  const root = document.documentElement;
  const savedTheme = localStorage.getItem('fgcall-theme');
  if (savedTheme) root.setAttribute('data-theme', savedTheme);
  else if (window.matchMedia('(prefers-color-scheme: dark)').matches) root.setAttribute('data-theme', 'dark');

  const roomId = document.body.dataset.roomId;
  const remoteVideo = document.getElementById('remoteVideo');
  const localVideo = document.getElementById('localVideo');
  const remotePlaceholder = document.getElementById('remotePlaceholder');
  const statusText = document.getElementById('statusText');
  const connIndicator = document.getElementById('connIndicator');
  const micBtn = document.getElementById('micBtn');
  const camBtn = document.getElementById('camBtn');
  const screenBtn = document.getElementById('screenBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const toast = document.getElementById('toast');

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // TURN servers can be appended here later
  ];

  const VIDEO_LEVELS = [
    { w: 640, h: 360, fps: 24, maxBitrate: 500000 },
    { w: 426, h: 240, fps: 20, maxBitrate: 250000 },
    { w: 320, h: 180, fps: 15, maxBitrate: 130000 }
  ];
  let currentLevel = 0;

  let socket = null;
  let pc = null;
  let localStream = null;
  let cameraTrack = null;
  let isInitiator = false;
  let micOn = true;
  let camOn = true;
  let screenSharing = false;
  let leaving = false;
  let statsTimer = null;
  let reconnectTimer = null;
  let makingOffer = false;

  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), ms || 2500);
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function setConnIndicator(state) {
    connIndicator.classList.remove('conn-connecting', 'conn-connected', 'conn-disconnected');
    if (state === 'connected') {
      connIndicator.textContent = 'Connected';
      connIndicator.classList.add('conn-connected');
    } else if (state === 'disconnected' || state === 'failed') {
      connIndicator.textContent = 'Reconnecting…';
      connIndicator.classList.add('conn-disconnected');
    } else {
      connIndicator.textContent = 'Connecting';
      connIndicator.classList.add('conn-connecting');
    }
  }

  async function initMedia() {
    const lvl = VIDEO_LEVELS[currentLevel];
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: lvl.w, height: lvl.h, frameRate: lvl.fps },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e) {
      setStatus('Camera/microphone permission denied.');
      showToast('Permission denied for camera/microphone.', 4000);
      throw e;
    }
    cameraTrack = localStream.getVideoTracks()[0];
    localVideo.srcObject = localStream;
  }

  function createPeerConnection() {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    pc.ontrack = (e) => {
      if (remoteVideo.srcObject !== e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        remotePlaceholder.style.display = 'none';
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({ type: 'ice', candidate: e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      setConnIndicator(state === 'connected' || state === 'completed' ? 'connected' : state);
      if (state === 'disconnected') {
        scheduleReconnectCheck();
      } else if (state === 'failed') {
        attemptIceRestart();
      } else if (state === 'connected' || state === 'completed') {
        clearTimeout(reconnectTimer);
      }
    };

    pc.onnegotiationneeded = async () => {
      if (!isInitiator) return;
      try {
        makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ type: 'offer', sdp: pc.localDescription });
      } catch (err) {
        // ignore
      } finally {
        makingOffer = false;
      }
    };
  }

  function scheduleReconnectCheck() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (pc && (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed')) {
        attemptIceRestart();
      }
    }, 4000);
  }

  async function attemptIceRestart() {
    if (!pc || leaving) return;
    if (isInitiator) {
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        sendSignal({ type: 'offer', sdp: pc.localDescription });
      } catch (e) {}
    }
  }

  function sendSignal(payload) {
    if (socket) socket.emit('signal', { room_id: roomId, payload });
  }

  async function handleSignal(payload) {
    if (!pc) return;
    if (payload.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: pc.localDescription });
    } else if (payload.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    } else if (payload.type === 'ice') {
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch (e) {}
    }
  }

  function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit('join', { room_id: roomId });
    });

    socket.on('joined', (data) => {
      isInitiator = data.initiator;
      setStatus('Waiting for peer to join…');
    });

    socket.on('join_error', (data) => {
      if (data.reason === 'room_full') {
        setStatus('Room is full (max 2 participants).');
        showToast('Room is full.', 4000);
      } else {
        setStatus('Invalid room.');
        showToast('Invalid room ID.', 4000);
      }
      setTimeout(() => { window.location.href = '/'; }, 2500);
    });

    socket.on('peer_joined', () => {
      setStatus('Peer joined. Connecting…');
      if (isInitiator && pc) {
        pc.onnegotiationneeded();
      }
    });

    socket.on('peer_left', () => {
      setStatus('Peer left the call.');
      remoteVideo.srcObject = null;
      remotePlaceholder.style.display = 'flex';
      setConnIndicator('connecting');
    });

    socket.on('signal', (data) => {
      handleSignal(data.payload);
    });

    socket.on('disconnect', () => {
      setConnIndicator('disconnected');
    });

    socket.io.on('reconnect', () => {
      socket.emit('join', { room_id: roomId });
    });
  }

  // ---- Adaptive quality via getStats ----
  let lastBytesSent = 0;
  let lastTs = 0;
  let badTicks = 0;
  let goodTicks = 0;

  async function monitorStats() {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let packetsLost = 0, packetsSent = 0, rtt = 0, found = false;
      stats.forEach((r) => {
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
          packetsLost = r.packetsLost || 0;
          rtt = r.roundTripTime || 0;
          found = true;
        }
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          packetsSent = r.packetsSent || packetsSent;
        }
      });
      if (found && packetsSent > 0) {
        const lossRatio = packetsLost / Math.max(packetsSent, 1);
        if (lossRatio > 0.05 || rtt > 0.4) {
          badTicks++; goodTicks = 0;
        } else {
          goodTicks++; badTicks = 0;
        }
        if (badTicks >= 2 && currentLevel < VIDEO_LEVELS.length - 1) {
          currentLevel++;
          applyVideoLevel();
          badTicks = 0;
        } else if (goodTicks >= 6 && currentLevel > 0) {
          currentLevel--;
          applyVideoLevel();
          goodTicks = 0;
        }
      }
    } catch (e) {}
  }

  function applyVideoLevel() {
    if (!pc || !cameraTrack) return;
    const lvl = VIDEO_LEVELS[currentLevel];
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = lvl.maxBitrate;
      sender.setParameters(params).catch(() => {});
    }
    if (cameraTrack.applyConstraints) {
      cameraTrack.applyConstraints({ width: lvl.w, height: lvl.h, frameRate: lvl.fps }).catch(() => {});
    }
  }

  // ---- Controls ----
  micBtn.addEventListener('click', () => {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    micBtn.classList.toggle('off', !micOn);
    micBtn.textContent = micOn ? '🎤' : '🔇';
  });

  camBtn.addEventListener('click', () => {
    if (!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    camBtn.classList.toggle('off', !camOn);
    camBtn.textContent = camOn ? '📷' : '🚫';
  });

  screenBtn.addEventListener('click', async () => {
    if (!pc) return;
    if (!screenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(screenTrack);
        localVideo.srcObject = screenStream;
        screenSharing = true;
        screenBtn.classList.add('off');
        screenTrack.onended = stopScreenShare;
      } catch (e) {}
    } else {
      stopScreenShare();
    }
  });

  async function stopScreenShare() {
    if (!pc || !cameraTrack) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(cameraTrack);
    localVideo.srcObject = localStream;
    screenSharing = false;
    screenBtn.classList.remove('off');
  }

  copyLinkBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      showToast('Link copied to clipboard.');
    }).catch(() => {
      showToast('Could not copy link.');
    });
  });

  leaveBtn.addEventListener('click', cleanupAndLeave);
  window.addEventListener('beforeunload', () => cleanupAndLeave(true));

  function cleanupAndLeave(silent) {
    if (leaving) return;
    leaving = true;
    clearInterval(statsTimer);
    clearTimeout(reconnectTimer);
    if (socket) {
      socket.emit('leave', { room_id: roomId });
      socket.disconnect();
    }
    if (pc) {
      pc.getSenders().forEach((s) => s.track && s.track.stop());
      pc.close();
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }
    if (!silent) window.location.href = '/';
  }

  async function main() {
    try {
      await initMedia();
    } catch (e) {
      return;
    }
    createPeerConnection();
    connectSocket();
    statsTimer = setInterval(monitorStats, 5000);
  }

  main();
})();
