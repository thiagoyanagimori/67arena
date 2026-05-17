/**
 * 67Arena — Real-time arm-raise battle game powered by MediaPipe Pose
 * ─────────────────────────────────────────────────────────────────────
 * MODES:
 *   solo   — single player, local leaderboard, no backend
 *   online — 1v1 real-time, Socket.IO backend required
 *
 * PHASE FLOW:
 *   menu ──► solo ──► countdown ──► playing ──► nickname ──► leaderboard
 *        └──► online ──► mode-select ──► create/join ──► waiting ──► online-countdown ──► online-playing ──► winner
 *
 * SOCKET.IO WIRE-UP (backend not yet required):
 *   1. npm install socket.io-client
 *   2. Set SOCKET_URL to your server
 *   3. Call SocketManager.connect(nickname)
 *   4. Events to implement server-side:
 *      Client emits:  create_room | join_room | rep_scored | ready
 *      Server emits:  match_found | countdown_tick | match_start | opponent_rep | match_end | opponent_left
 *
 * MEDIAPIPE POSE DETECTION (unchanged):
 *   - Both arms tracked independently
 *   - Rep = wrist above shoulder → below shoulder
 *   - JITTER_THRESHOLD dead-zone prevents false reps
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { io as socketIO } from "socket.io-client";

// ─── TUNING CONSTANTS ─────────────────────────────────────────────────────────

const GAME_DURATION    = 10;
const JITTER_THRESHOLD = 0.04;
const COMBO_WINDOW_MS  = 1800;
const COUNTDOWN_FROM   = 3;

// ─── ONLINE CONFIG ────────────────────────────────────────────────────────────
// Set this to your Socket.IO server URL before enabling online mode.
// When SOCKET_URL is null, online mode shows a "coming soon" stub.
const SOCKET_URL = "https://six7arena.onrender.com";

// ─── MEDIAPIPE CDNS ───────────────────────────────────────────────────────────

const MP_POSE    = "https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/pose.js";
const MP_CAMERA  = "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js";
const MP_DRAWING = "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.js";

// MediaPipe landmark indices — only upper-body joints used (face/body ignored)
const LM = {
  LEFT_SHOULDER:  11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW:     13,
  RIGHT_ELBOW:    14,
  LEFT_WRIST:     15,
  RIGHT_WRIST:    16,
};

// ─── SOUND MANAGER — centralized Web Audio API, no external files ─────────────
// Single entry point: playSound(type). Respects global mute state.
// All tones synthesised on demand — zero network requests.
const SoundManager = (() => {
  let ctx    = null;
  let muted  = false;
  // Debounce map: type → last played timestamp (prevents spam)
  const lastPlayed = {};

  function getCtx() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
    }
    if (ctx?.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  // Low-level: schedule an oscillator
  function osc({ freq = 440, type = "sine", gain = 0.15, duration = 0.12,
                  attack = 0.005, decay = 0.09, freqEnd = null, startDelay = 0 }) {
    const c = getCtx(); if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.connect(g); g.connect(c.destination);
    o.type = type;
    const t = c.currentTime + startDelay;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + duration);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.start(t); o.stop(t + duration + 0.05);
  }

  // Low-level: schedule a noise burst
  function burst({ duration = 0.06, gain = 0.1, filter = 800, startDelay = 0 }) {
    const c = getCtx(); if (!c) return;
    const bufSize = Math.floor(c.sampleRate * duration);
    const buf = c.createBuffer(1, bufSize, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    const bpf = c.createBiquadFilter();
    const g   = c.createGain();
    src.buffer = buf;
    bpf.type = "bandpass"; bpf.frequency.value = filter;
    src.connect(bpf); bpf.connect(g); g.connect(c.destination);
    const t = c.currentTime + startDelay;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.start(t); src.stop(t + duration + 0.02);
  }

  // Debounce: skip if same type played within `minGapMs`
  function debounce(type, minGapMs = 80) {
    const now = Date.now();
    if (lastPlayed[type] && now - lastPlayed[type] < minGapMs) return false;
    lastPlayed[type] = now;
    return true;
  }

  // ── Sound definitions ────────────────────────────────────────────────────
  const sounds = {
    // UI
    click() {
      osc({ freq: 600, freqEnd: 900, type: "sine", gain: 0.12, duration: 0.07, decay: 0.06 });
    },
    hover() {
      osc({ freq: 440, type: "sine", gain: 0.06, duration: 0.05, decay: 0.04 });
    },

    // Countdown
    countTick(n = 3) {
      const freq = n <= 1 ? 880 : n === 2 ? 660 : 440;
      osc({ freq, type: "sine", gain: 0.2, duration: 0.15, decay: 0.1 });
    },
    go() {
      // Punchy rising 3-note chord
      [260, 330, 520].forEach((f, i) => {
        osc({ freq: f, freqEnd: f * 1.4, type: "square", gain: 0.14,
              duration: 0.2, attack: 0.003, decay: 0.15, startDelay: i * 0.04 });
      });
    },

    // Gameplay
    rep(combo = 1) {
      const base = 300 + Math.min(combo - 1, 9) * 40;
      osc({ freq: base, freqEnd: base * 1.5, type: "square",
            gain: 0.13, duration: 0.1, attack: 0.002, decay: 0.09 });
      burst({ duration: 0.04, gain: 0.07, filter: 1200 });
    },
    combo(tier = 3) {
      // Higher tiers get brighter, more aggressive chords
      const base = 400 + tier * 30;
      osc({ freq: base,        type: "sawtooth", gain: 0.12, duration: 0.12, decay: 0.1 });
      osc({ freq: base * 1.25, type: "square",   gain: 0.08, duration: 0.1,  decay: 0.08, startDelay: 0.03 });
    },
    comboBreak() {
      osc({ freq: 500, freqEnd: 200, type: "sawtooth", gain: 0.1, duration: 0.15, decay: 0.12 });
    },

    // Timer
    timerWarn() {
      // Low urgent pulse
      osc({ freq: 220, freqEnd: 180, type: "sine", gain: 0.15, duration: 0.18, decay: 0.15 });
    },

    // Match end
    matchOver() {
      osc({ freq: 440, freqEnd: 110, type: "sawtooth", gain: 0.2, duration: 0.5,
            attack: 0.01, decay: 0.45 });
    },
    victory() {
      [330, 415, 523, 659, 830].forEach((f, i) => {
        osc({ freq: f, type: "triangle", gain: 0.16, duration: 0.28,
              decay: 0.22, startDelay: i * 0.08 });
      });
    },
    defeat() {
      [330, 294, 247, 220].forEach((f, i) => {
        osc({ freq: f, type: "sine", gain: 0.14, duration: 0.3,
              decay: 0.25, startDelay: i * 0.1 });
      });
    },

    // Online
    matchFound() {
      // Rising "ping" — match discovered
      [440, 550, 660].forEach((f, i) => {
        osc({ freq: f, freqEnd: f * 1.1, type: "sine", gain: 0.18, duration: 0.2,
              attack: 0.005, decay: 0.15, startDelay: i * 0.06 });
      });
    },
    rematch() {
      // Crisp upward confirm
      [500, 700].forEach((f, i) => {
        osc({ freq: f, type: "square", gain: 0.12, duration: 0.12,
              decay: 0.1, startDelay: i * 0.05 });
      });
    },
  };

  // ── Public API ────────────────────────────────────────────────────────────
  function playSound(type, ...args) {
    if (muted) return;
    if (!debounce(type, type === "hover" ? 120 : type === "rep" ? 60 : 80)) return;
    const fn = sounds[type];
    if (fn) fn(...args);
    else console.warn(`[Sound] Unknown type: ${type}`);
  }

  function setMuted(val) { muted = val; }
  function isMuted()     { return muted; }

  // Legacy API surface — keeps existing call sites working
  const SoundEngine = {
    repScored:   (combo) => playSound("rep", combo),
    comboBreak:  ()      => playSound("comboBreak"),
    countTick:   (n)     => playSound("countTick", n),
    matchStart:  ()      => playSound("go"),
    matchEnd:    ()      => playSound("matchOver"),
    victory:     ()      => playSound("victory"),
    ambientLoop: ()      => {},
    stopAmbient: ()      => {},
  };

  return { playSound, setMuted, isMuted, SoundEngine };
})();

// Re-export SoundEngine at module scope so all existing call sites work unchanged
const SoundEngine = SoundManager.SoundEngine;
// Convenience alias
const playSound = SoundManager.playSound.bind(SoundManager);

// ─── REP DETECTION (pure, stateless — unchanged logic from ArmRush) ──────────
/**
 * detectRepEvent
 * Determines if a single arm has completed a rep cycle this frame.
 *
 * @param {number} wristY     – normalised Y of wrist   (0 = top, 1 = bottom)
 * @param {number} shoulderY  – normalised Y of shoulder
 * @param {'idle'|'raised'} prevState – arm FSM state from previous frame
 * @returns {{ newState: string, scored: boolean }}
 */
function detectRepEvent(wristY, shoulderY, prevState) {
  // Wrist "above" = smaller Y value (higher in frame) than shoulder
  const wristAboveShoulder = wristY < shoulderY - JITTER_THRESHOLD;
  const wristBelowShoulder = wristY > shoulderY + JITTER_THRESHOLD;

  // Transition: rest → raised
  if (prevState === "idle" && wristAboveShoulder) {
    return { newState: "raised", scored: false };
  }
  // Transition: raised → rest (rep complete!)
  if (prevState === "raised" && wristBelowShoulder) {
    return { newState: "idle", scored: true };
  }
  return { newState: prevState, scored: false };
}

// ─── COMBO TIER LABELS ────────────────────────────────────────────────────────
function getComboTier(combo) {
  if (combo >= 10) return { label: "LEGENDARY", color: "#ff0040" };
  if (combo >= 7)  return { label: "UNSTOPPABLE", color: "#ff3300" };
  if (combo >= 5)  return { label: "ON FIRE", color: "#ff6b00" };
  if (combo >= 3)  return { label: "COMBO", color: "#ff9500" };
  return null;
}

// ─── RESULT MESSAGE ───────────────────────────────────────────────────────────
function getResultMessage(score) {
  if (score === 0)  return { title: "NO REPS!", sub: "You didn't move — try again" };
  if (score < 4)    return { title: "WARMING UP", sub: "Push harder next time" };
  if (score < 8)    return { title: "SOLID RUN", sub: "Keep climbing, fighter" };
  if (score < 13)   return { title: "BEAST MODE", sub: "The arena felt that" };
  return            { title: "LEGENDARY", sub: "67Arena all-time elite" };
}

// ─── LEADERBOARD — localStorage persistence ───────────────────────────────────
// Entry shape: { nickname, score, date } — extend with roomId for multiplayer
const LS_KEY = "arena67_leaderboard";
const LB_MAX = 10;

const Leaderboard = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    } catch { return []; }
  },
  save(entries) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(entries)); } catch {}
  },
  addEntry(nickname, score) {
    const entries = Leaderboard.load();
    entries.push({ nickname: nickname.trim().slice(0, 16) || "FIGHTER", score, date: Date.now() });
    entries.sort((a, b) => b.score - a.score);
    const trimmed = entries.slice(0, LB_MAX);
    Leaderboard.save(trimmed);
    return trimmed;
  },
  // Return the rank (1-based) of the most recently added entry
  latestRank(entries, score, date) {
    return entries.findIndex(e => e.score === score && e.date === date) + 1;
  },
};

// ─── SOCKET MANAGER — matchmaking-only Socket.IO client ─────────────────────
// No room codes, no private rooms. Server handles all pairing automatically.
//
// SERVER CONTRACT (Node.js + Socket.IO):
//   Client emits:
//     join_queue   { nickname }  → player enters matchmaking pool
//     leave_queue  {}            → player cancels before match found
//     rep_scored   { score, combo } → rebroadcast to opponent in same match
//     client_ready {}            → ack that countdown is ticking on this client
//
//   Server emits:
//     queue_joined  { position }          → confirmation, queue depth
//     match_found   { opponentNickname }  → pair locked, show opponent
//     countdown_tick { count }            → 3…2…1 synced to both clients
//     match_start   {}                    → both start playing simultaneously
//     opponent_rep  { score, combo }      → live opponent update
//     match_end     { winner, scores: { local, opponent } }
//     opponent_left {}                    → opponent disconnected mid-match
//
// BACKEND QUEUE ALGORITHM (pseudocode, implement in server.js):
//   waitingQueue = []
//   on join_queue(socket, { nickname }):
//     socket.nickname = nickname
//     waitingQueue.push(socket)
//     if waitingQueue.length >= 2:
//       [p1, p2] = waitingQueue.splice(0, 2)
//       roomId = uuid()
//       p1.join(roomId); p2.join(roomId)
//       io.to(roomId).emit('match_found', ...)
//       startCountdown(roomId, io)
//   on disconnect(socket):
//     waitingQueue = waitingQueue.filter(s => s.id !== socket.id)
//     notify roommate via 'opponent_left'
const SocketManager = (() => {
  let socket = null;
  const handlers = {};
  // Reactive status callbacks — lets the React component observe real connection state
  let _onStatusChange = null;

  function isAvailable() {
    // SOCKET_URL existing is enough — we use the npm socket.io-client import
    return Boolean(SOCKET_URL);
  }

  // Returns "connected" | "disconnected" | "unavailable"
  // Uses socket.connected as the single source of truth
  function getStatus() {
    if (!SOCKET_URL) return "unavailable";
    if (socket?.connected === true) return "connected";
    return "disconnected";
  }

  function onStatusChange(fn) { _onStatusChange = fn; }
  function _fireStatus() { _onStatusChange?.(getStatus()); }

  function connect(nickname, onConnect, onError) {
    if (!SOCKET_URL) { onError?.("No server URL configured."); return; }
    if (socket?.connected) { onConnect?.(socket.id); _fireStatus(); return; }
    // Use the npm-imported io, not window.io
    socket = socketIO(SOCKET_URL, { transports: ["websocket"], autoConnect: true });
    socket.on("connect", () => {
      _fireStatus();           // fires "connected" — socket.connected is now true
      onConnect?.(socket.id);
    });
    socket.on("disconnect", () => _fireStatus());  // fires "disconnected"
    socket.on("connect_error", (e) => {
      _fireStatus();
      onError?.(e.message);
    });
    Object.entries(handlers).forEach(([ev, fn]) => socket.on(ev, fn));
  }

  function disconnect() { socket?.disconnect(); socket = null; _fireStatus(); }

  function on(event, fn) {
    handlers[event] = fn;
    socket?.on(event, fn);
  }

  function off(event) { delete handlers[event]; socket?.off(event); }

  function emit(event, data) {
    if (!socket?.connected) { console.warn(`[Socket] '${event}' dropped`); return; }
    socket.emit(event, data);
  }

  // ── Matchmaking emitters ──────────────────────────────────────────────────
  function joinQueue(nickname)   { emit("join_queue",       { nickname }); }
  function leaveQueue()          { emit("leave_queue",      {}); }
  function emitRep(score, combo) { emit("rep_scored",       { score, combo }); }
  function emitReady()           { emit("client_ready",     {}); }

  // ── Post-match emitters ───────────────────────────────────────────────────
  function voteRematch()       { emit("rematch_vote",   {}); }
  function findAnother()       { emit("find_another",   {}); }

  // ── Voice/video signalling emitters (relay via server, standardised names) ──
  function voiceOffer(sdp)     { emit("webrtc_offer",         { sdp }); }
  function voiceAnswer(sdp)    { emit("webrtc_answer",        { sdp }); }
  function voiceIce(candidate) { emit("webrtc_ice_candidate", { candidate }); }

  return { isAvailable, getStatus, onStatusChange, connect, disconnect, on, off, emit,
           joinQueue, leaveQueue, emitRep, emitReady,
           voteRematch, findAnother, voiceOffer, voiceAnswer, voiceIce };
})();

// ─── MEDIA ENGINE — WebRTC video+audio between matched players ───────────────
// Replaces VoiceEngine. Camera + mic both included.
// Remote stream is displayed in a <video> element whose ref is exposed.
//
// SERVER SIGNALLING CONTRACT (server.js already handles these):
//   Client emits:  voice_offer   { sdp }      → relay to room partner
//                  voice_answer  { sdp }       → relay to room partner
//                  voice_ice     { candidate } → relay to room partner
const VoiceEngine = (() => {   // kept as "VoiceEngine" so all existing call-sites work
  let pc            = null;
  let localStream   = null;    // camera + mic MediaStream (local player)
  let remoteVideoEl = null;    // <video> element for opponent feed (set via setRemoteVideoEl)
  let _muted        = false;
  let _camOff       = false;

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // ── Set the <video> element the remote stream should play into ───────────
  // Call this from the component after the ref is attached.
  function setRemoteVideoEl(el) { remoteVideoEl = el; }

  // ── Request camera + microphone ──────────────────────────────────────────
  // Returns: "granted" | "denied" | "unavailable"
  async function requestMic() {
    if (!navigator.mediaDevices?.getUserMedia) return "unavailable";
    try {
      // Ask for both video and audio for the online call.
      // The existing MediaPipe camera (videoRef) runs separately — we request
      // a second stream here purely for the WebRTC peer connection.
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: true,
      });
      return "granted";
    } catch (e) {
      // Fallback: try audio-only if camera is blocked
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        return "granted";
      } catch {
        return "denied";
      }
    }
  }

  // ── Create RTCPeerConnection and add local tracks ────────────────────────
  function _createPc() {
    if (pc) { pc.close(); pc = null; }  // clean up any stale connection
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add all local tracks (video + audio) to the peer connection
    if (localStream) {
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    // When remote tracks arrive, wire them to the video element
    pc.ontrack = (e) => {
      console.log("[WebRTC] ontrack fired, streams:", e.streams.length);
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      if (remoteVideoEl) {
        remoteVideoEl.srcObject = stream;
        remoteVideoEl.play().catch(err => console.warn("[WebRTC] play():", err));
      } else {
        console.warn("[WebRTC] remoteVideoEl not set yet");
      }
    };

    // Relay ICE candidates via the standardised webrtc_ event names
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        SocketManager.emit("webrtc_ice_candidate", { candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("[WebRTC] connection state:", pc?.connectionState);
    };
  }

  // ── Start call — isInitiator=true sends the offer ────────────────────────
  async function startCall(isInitiator) {
    _createPc();  // always create fresh PC; localStream may be null (mic-denied) — still ok
    if (isInitiator) {
      try {
        const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        SocketManager.emit("webrtc_offer", { sdp: pc.localDescription });
        console.log("[WebRTC] offer sent");
      } catch (err) {
        console.error("[WebRTC] startCall error:", err);
      }
    }
  }

  // ── Handle incoming offer from opponent (non-initiator) ──────────────────
  async function handleOffer(sdp) {
    try {
      if (!pc) _createPc();
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      SocketManager.emit("webrtc_answer", { sdp: pc.localDescription });
      console.log("[WebRTC] answer sent");
    } catch (err) {
      console.error("[WebRTC] handleOffer error:", err);
    }
  }

  async function handleAnswer(sdp) {
    try {
      await pc?.setRemoteDescription(new RTCSessionDescription(sdp));
      console.log("[WebRTC] remote description set (answer)");
    } catch (err) {
      console.error("[WebRTC] handleAnswer error:", err);
    }
  }

  async function handleIce(candidate) {
    try {
      if (pc && candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (err) {
      console.warn("[WebRTC] addIceCandidate:", err);
    }
  }

  // ── Mute / unmute mic ────────────────────────────────────────────────────
  function setMuted(muted) {
    _muted = muted;
    localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }
  function isMuted() { return _muted; }

  // ── Camera on/off ────────────────────────────────────────────────────────
  function setCamOff(off) {
    _camOff = off;
    localStream?.getVideoTracks().forEach(t => { t.enabled = !off; });
  }
  function isCamOff() { return _camOff; }

  // ── Tear down ─────────────────────────────────────────────────────────────
  function hangup() {
    pc?.close(); pc = null;
    localStream?.getTracks().forEach(t => t.stop()); localStream = null;
    if (remoteVideoEl) { remoteVideoEl.srcObject = null; }
    remoteVideoEl = null;
    _muted = false; _camOff = false;
  }

  // ── Check if we have a video track (for UI) ──────────────────────────────
  function hasVideo() {
    return (localStream?.getVideoTracks().length ?? 0) > 0;
  }

  return { requestMic, setRemoteVideoEl, startCall, handleOffer, handleAnswer,
           handleIce, setMuted, isMuted, setCamOff, isCamOff, hasVideo, hangup };
})();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.crossOrigin = "anonymous";
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ─── INJECT GLOBAL CSS ────────────────────────────────────────────────────────
if (typeof document !== "undefined" && !document.getElementById("arena-styles")) {
  const el = document.createElement("style");
  el.id = "arena-styles";
  el.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Barlow:wght@400;600&display=swap');

    *, *::before, *::after { box-sizing: border-box; }

    html {
      margin: 0; padding: 0;
      width: 100%; height: 100vh;
      overflow: hidden;
    }

    body {
      margin: 0; padding: 0;
      width: 100%; height: 100%;
      overflow: hidden;
      background: #050509;
    }

    #root {
      margin: 0; padding: 0;
      width: 100%; height: 100%;
      display: grid;
      place-items: center;
    }

    .arena-page {
      width: 100%; height: 100%;
      display: grid;
      place-items: center;
    }

    .arena-root {
      width: min(92vw, 1150px);
      aspect-ratio: 16 / 9;
      max-height: 78vh;
      margin: 0;
      position: relative;
      box-sizing: border-box;
      border-radius: 22px;
      overflow: hidden;
      background: #05050a;
      box-shadow:
        0 0 0 1px rgba(255,98,0,0.2),
        0 0 80px rgba(255,98,0,0.07),
        0 24px 60px rgba(0,0,0,0.65);
      font-family: 'Barlow', sans-serif;
    }

    @media (max-width: 700px) {
      .arena-root {
        width: min(96vw, 430px);
        height: min(88vh, 760px);
        aspect-ratio: 9 / 16;
      }
    }

    /* Scanline CRT texture — fixed so it always covers the full viewport */
    .arena-scanline {
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(
        0deg, transparent, transparent 2px,
        rgba(0,0,0,0.055) 2px, rgba(0,0,0,0.055) 4px
      );
      pointer-events: none;
      z-index: 99999;
    }

    /* ── HUD typography scales with container width via clamp ── */
    .arena-hud-value {
      font-size: clamp(22px, 4.5vw, 48px);
    }
    .arena-hud-label {
      font-size: clamp(7px, 1vw, 11px);
    }
    .arena-logo-67 {
      font-size: clamp(18px, 3vw, 32px);
    }
    .arena-logo-text {
      font-size: clamp(7px, 0.9vw, 10px);
    }
    .arena-overlay-title {
      font-size: clamp(20px, 3.5vw, 34px);
    }
    .arena-overlay-sub {
      font-size: clamp(11px, 1.6vw, 15px);
    }
    .arena-overlay-hint {
      font-size: clamp(9px, 1.2vw, 12px);
    }
    .arena-countdown-big {
      font-size: clamp(60px, 12vw, 110px);
    }
    .arena-result-score {
      font-size: clamp(56px, 11vw, 96px);
    }
    .arena-btn {
      font-size: clamp(11px, 1.6vw, 14px);
      padding: clamp(9px,1.2vw,14px) clamp(20px,3vw,36px);
      letter-spacing: clamp(1px, 0.4vw, 4px);
    }
    .arena-arm-label {
      font-size: clamp(7px, 1vw, 10px);
    }
    .arena-arm-arrow {
      font-size: clamp(14px, 2.5vw, 22px);
    }
    .arena-glass-card {
      padding: clamp(20px, 3vw, 36px) clamp(20px, 4vw, 44px);
      gap: clamp(8px, 1.2vw, 14px);
      max-width: min(90%, 380px);
    }

    /* Wide variant for leaderboard — allows more horizontal space */
    .arena-glass-card--wide {
      max-width: min(96%, 620px) !important;
      padding: clamp(16px, 2.5vw, 28px) clamp(16px, 3vw, 36px) !important;
    }

    /* ── Existing keyframes ── */
    @keyframes arena-spin      { to { transform: rotate(360deg); } }
    @keyframes arena-pulse     { 0%,100%{opacity:1} 50%{opacity:0.4} }
    @keyframes arena-loadbar   { 0%,100%{width:15%} 50%{width:85%} }
    @keyframes arena-pop       { 0%{transform:scale(0.5) translateY(10px);opacity:0}
                                 60%{transform:scale(1.15) translateY(-4px);opacity:1}
                                 100%{transform:scale(1) translateY(0);opacity:1} }
    @keyframes arena-shake     { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)}
                                 75%{transform:translateX(4px)} }
    @keyframes arena-glow      { 0%,100%{text-shadow:0 0 20px #ff6200aa}
                                 50%{text-shadow:0 0 50px #ff6200, 0 0 80px #ff000088} }
    @keyframes arena-scorepop  { 0%{transform:translateY(0) scale(1)}
                                 40%{transform:translateY(-12px) scale(1.3)}
                                 100%{transform:translateY(0) scale(1)} }
    @keyframes arena-timewarn  { 0%,100%{color:#ff3300;text-shadow:0 0 20px #ff330088}
                                 50%{color:#ff6600;text-shadow:0 0 40px #ff6600} }
    @keyframes arena-combopop  { 0%{opacity:0;transform:translateY(20px) scale(0.8)}
                                 30%{opacity:1;transform:translateY(-5px) scale(1.1)}
                                 70%{opacity:1;transform:translateY(0) scale(1)}
                                 100%{opacity:0;transform:translateY(-20px) scale(0.9)} }
    @keyframes arena-logorise  { 0%{opacity:0;transform:translateY(30px) scaleX(1.1)}
                                 100%{opacity:1;transform:translateY(0) scaleX(1)} }
    @keyframes arena-countscale{ 0%{transform:scale(1.6);opacity:0}
                                 40%{transform:scale(0.95);opacity:1}
                                 100%{transform:scale(1);opacity:1} }
    @keyframes arena-victoryray{ 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }

    /* ── New game-feel keyframes ── */

    /* Full-screen orange flash on rep */
    @keyframes arena-repflash  {
      0%   { opacity: 0.38; }
      100% { opacity: 0; }
    }

    /* Expanding ring from the scored arm — radiates outward and fades */
    @keyframes arena-ring {
      0%   { transform: scale(0.4); opacity: 0.9; }
      100% { transform: scale(3.5); opacity: 0; }
    }

    /* Score digit — bigger pop with overshoot spring */
    @keyframes arena-scorebounce {
      0%   { transform: scale(1); }
      25%  { transform: scale(1.55) translateY(-8px); }
      55%  { transform: scale(0.92) translateY(2px); }
      75%  { transform: scale(1.12); }
      100% { transform: scale(1); }
    }

    /* Screen shake — applied to arena-root on rep */
    @keyframes arena-screenshake {
      0%,100% { transform: translate(0,0); }
      20%     { transform: translate(-3px, 2px); }
      40%     { transform: translate(3px, -2px); }
      60%     { transform: translate(-2px, -3px); }
      80%     { transform: translate(2px, 3px); }
    }

    /* GO! — explosive scale-in */
    @keyframes arena-go {
      0%   { transform: scale(3) rotate(-4deg); opacity: 0; filter: blur(8px); }
      50%  { transform: scale(0.88) rotate(1deg); opacity: 1; filter: blur(0); }
      75%  { transform: scale(1.06); }
      100% { transform: scale(1); opacity: 1; }
    }

    /* Timer heartbeat — double-pulse at low time */
    @keyframes arena-heartbeat {
      0%,100%{ transform: scale(1); }
      14%    { transform: scale(1.18); }
      28%    { transform: scale(1); }
      42%    { transform: scale(1.12); }
      56%    { transform: scale(1); }
    }

    /* Combo label slam — drops in from top */
    @keyframes arena-comboenter {
      0%   { transform: translateY(-24px) scale(1.2); opacity: 0; }
      60%  { transform: translateY(3px)   scale(0.97); opacity: 1; }
      100% { transform: translateY(0)     scale(1);    opacity: 1; }
    }

    /* Floating +1 chip that rises and fades */
    @keyframes arena-plusone {
      0%   { transform: translateY(0) scale(1);    opacity: 1; }
      100% { transform: translateY(-52px) scale(0.7); opacity: 0; }
    }

    /* HUD top-bar breathe during play */
    @keyframes arena-hudbreathe {
      0%,100%{ background: rgba(0,0,0,0.88); }
      50%    { background: rgba(20,5,0,0.92); }
    }

    /* Radar rings for matchmaking searching screen */
    @keyframes arena-radar {
      0%   { transform: scale(0.3); opacity: 0.8; }
      100% { transform: scale(2.6); opacity: 0; }
    }
  `;
  document.head.appendChild(el);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function Arena67() {
  // ── Refs ───────────────────────────────────────────────────────────────────
  const videoRef   = useRef(null);
  const canvasRef  = useRef(null);
  const poseRef    = useRef(null);
  const cameraRef  = useRef(null);
  const timerRef   = useRef(null);
  const flashRef   = useRef(null);
  const comboTimerRef = useRef(null);
  const shakeTimerRef   = useRef(null);
  const plusOneTimerRef = useRef(null);
  const pendingEntryRef = useRef(null);
  const micStatusRef    = useRef("idle");
  const remoteVideoRef  = useRef(null);  // <video> element for opponent camera feed

  // Wire the remote video element into VoiceEngine as soon as it's available
  useEffect(() => {
    VoiceEngine.setRemoteVideoEl(remoteVideoRef.current);
  }, []);

  // ── Game state ref (single source of truth — easy to sync via Socket.IO) ──
  // To extend for multiplayer, replace with:
  //   { localPlayer: {...}, remotePlayer: {...}, roomId, phase, timeLeft }
  const gameRef = useRef({
    score:        0,
    repState:     { left: "idle", right: "idle" },
    phase:        "idle",   // idle | countdown | playing | done
    timeLeft:     GAME_DURATION,
    combo:        0,
    lastComboTime: 0,
  });

  // ── React UI state (derived from gameRef for rendering) ────────────────────
  const [ui, setUi] = useState({
    phase:        "menu",   // menu | solo | countdown | playing | nickname | leaderboard
                            // | online-lobby | online-waiting | online-countdown | online-playing | winner
    gameMode:     null,     // "solo" | "online"
    score:        0,
    timeLeft:     GAME_DURATION,
    poseReady:    false,
    armState:     { left: "idle", right: "idle" },
    lastRep:      null,
    combo:        0,
    comboTier:    null,
    showCombo:    false,
    countdown:    COUNTDOWN_FROM,
    scoreAnimate: false,
    screenFlash:  false,
    screenShake:  false,
    showRing:     null,
    showPlusOne:  false,
    lbEntries:    [],
    lbLatestDate: null,
    // Online multiplayer state
    onlineNickname:   "",
    roomCode:         "",
    isHost:           false,
    opponentNickname: "",
    opponentScore:    0,
    onlineError:      "",
    socketConnected:  false,
    // Microphone / voice
    micStatus:        "idle",
    micMuted:         false,
    voiceStatus:      "off",
    camOff:           false,
    // Rematch
    rematchState:     "idle",
    myRematchVote:    false,
    opponentRematchVote: false,
    // Server connectivity — reflects real socket.connected state
    serverStatus:     SocketManager.getStatus(),
  });

  // ── Batched UI sync (avoids per-frame re-renders) ──────────────────────────
  const syncUi = useCallback((patch) => {
    setUi(prev => ({ ...prev, ...patch }));
  }, []);

  // ── Subscribe to SocketManager connection status changes ───────────────────
  useEffect(() => {
    SocketManager.onStatusChange((status) => syncUi({ serverStatus: status }));
    return () => SocketManager.onStatusChange(null);
  }, [syncUi]);

  // ── Score a rep ─────────────────────────────────────────────────────────────
  // Socket.IO hook: add socket.emit('rep', { side, score, combo }) here
  const scoreRep = useCallback((side) => {
    const game = gameRef.current;
    if (game.phase !== "playing" && game.phase !== "online-playing") return;
    const now = Date.now();

    // Combo logic: consecutive reps within COMBO_WINDOW_MS build a streak
    if (now - game.lastComboTime < COMBO_WINDOW_MS) {
      game.combo += 1;
    } else {
      if (game.combo > 0) SoundEngine.comboBreak();
      game.combo = 1;
    }
    game.lastComboTime = now;
    game.score += 1;

    const tier = getComboTier(game.combo);
    SoundEngine.repScored(game.combo);

    // Emit to server in online mode — server rebroadcasts to opponent
    if (ui.gameMode === "online") SocketManager.emitRep(game.score, game.combo);

    // Trigger all visual feedback simultaneously
    syncUi({
      score:        game.score,
      lastRep:      side,
      combo:        game.combo,
      comboTier:    tier,
      showCombo:    game.combo >= 3,
      scoreAnimate: true,
      screenFlash:  true,        // orange vignette flash
      screenShake:  true,        // arena-root shake
      showRing:     side,        // expanding ring on scored arm
      showPlusOne:  true,        // floating +1
    });

    // Clear transient effects
    clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => {
      syncUi({ lastRep: null, screenFlash: false, showRing: null,
               showPlusOne: false, scoreAnimate: false });
    }, 380);

    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => syncUi({ screenShake: false }), 300);

    clearTimeout(comboTimerRef.current);
    comboTimerRef.current = setTimeout(() => syncUi({ showCombo: false }), 1300);
  }, [syncUi]);

  // ── MediaPipe results callback ─────────────────────────────────────────────
  const onPoseResults = useCallback((results) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const game = gameRef.current;

    // Mirror-flip the canvas so it acts like a selfie camera
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

    if (!results.poseLandmarks) { ctx.restore(); return; }

    const lm = results.poseLandmarks;

    // ── Draw upper-body skeleton (shoulder → elbow → wrist only) ─────────────
    if (window.drawConnectors && window.POSE_CONNECTIONS) {
      const armConnections = window.POSE_CONNECTIONS.filter(([a, b]) =>
        [11, 12, 13, 14, 15, 16].includes(a) && [11, 12, 13, 14, 15, 16].includes(b)
      );
      const skeletonColor = (game.phase === "playing" || game.phase === "online-playing")
        ? "#ff6200" : "rgba(255,255,255,0.25)";
      window.drawConnectors(ctx, lm, armConnections, { color: skeletonColor, lineWidth: 3 });
      window.drawLandmarks(ctx, [
        lm[LM.LEFT_SHOULDER],  lm[LM.RIGHT_SHOULDER],
        lm[LM.LEFT_ELBOW],    lm[LM.RIGHT_ELBOW],
        lm[LM.LEFT_WRIST],    lm[LM.RIGHT_WRIST],
      ], { color: "#ff0040", lineWidth: 2, radius: 7 });
    }
    ctx.restore();

    // ── Rep detection — only during active play (solo or online) ─────────────
    // NOTE: we intentionally DO NOT track face or body shape —
    //       only wrist/shoulder Y positions are compared.
    if (game.phase !== "playing" && game.phase !== "online-playing") return;

    for (const side of ["left", "right"]) {
      const shoulderIdx = side === "left" ? LM.LEFT_SHOULDER  : LM.RIGHT_SHOULDER;
      const wristIdx    = side === "left" ? LM.LEFT_WRIST     : LM.RIGHT_WRIST;
      const shoulder    = lm[shoulderIdx];
      const wrist       = lm[wristIdx];

      // Skip low-confidence landmarks (occlusion, off-screen)
      if (!shoulder || !wrist) continue;
      if ((shoulder.visibility ?? 1) < 0.5) continue;
      if ((wrist.visibility    ?? 1) < 0.5) continue;

      const prevState = game.repState[side];
      const { newState, scored } = detectRepEvent(wrist.y, shoulder.y, prevState);

      if (newState !== prevState) {
        game.repState[side] = newState;
        syncUi({ armState: { ...game.repState } });
      }
      if (scored) scoreRep(side);
    }
  }, [scoreRep, syncUi]);

  // ── Initialise MediaPipe (once on mount) ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        await loadScript(MP_POSE);
        await loadScript(MP_CAMERA);
        await loadScript(MP_DRAWING);
        if (cancelled) return;

        const pose = new window.Pose({
          locateFile: (f) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}`,
        });
        pose.setOptions({
          modelComplexity: 1,
          smoothLandmarks: true,
          enableSegmentation: false,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        pose.onResults(onPoseResults);
        poseRef.current = pose;

        const cam = new window.Camera(videoRef.current, {
          onFrame: async () => {
            if (poseRef.current && videoRef.current)
              await poseRef.current.send({ image: videoRef.current });
          },
          width: 640, height: 480,
        });
        cameraRef.current = cam;
        await cam.start();
        if (!cancelled) syncUi({ poseReady: true });
      } catch (err) {
        console.error("67Arena: MediaPipe init error", err);
      }
    }
    init();
    return () => { cancelled = true; cameraRef.current?.stop(); };
  }, [onPoseResults, syncUi]);

  // ── Solo game flow: countdown → playing → nickname ─────────────────────────
  const startSoloGame = useCallback(() => {
    clearInterval(timerRef.current);
    const game = gameRef.current;
    game.score = 0; game.repState = { left: "idle", right: "idle" };
    game.phase = "countdown"; game.timeLeft = GAME_DURATION;
    game.combo = 0; game.lastComboTime = 0;

    syncUi({
      phase: "countdown", gameMode: "solo", score: 0, timeLeft: GAME_DURATION,
      lastRep: null, combo: 0, comboTier: null, showCombo: false,
      countdown: COUNTDOWN_FROM,
    });
    SoundEngine.ambientLoop();

    let count = COUNTDOWN_FROM;
    SoundEngine.countTick(count);

    const countInterval = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(countInterval);
        game.phase = "playing";
        syncUi({ phase: "playing", countdown: 0 });
        SoundEngine.matchStart();
        timerRef.current = setInterval(() => {
          game.timeLeft--;
          syncUi({ timeLeft: game.timeLeft });
          if (game.timeLeft <= 3 && game.timeLeft > 0) playSound("timerWarn");
          if (game.timeLeft <= 0) {
            clearInterval(timerRef.current);
            game.phase = "done";
            const endDate = Date.now();
            pendingEntryRef.current = { score: game.score, date: endDate };
            syncUi({ phase: "nickname", score: game.score });
            SoundEngine.matchEnd();
            SoundEngine.stopAmbient();
            if (game.score > 0) SoundEngine.victory();
          }
        }, 1000);
      } else {
        syncUi({ countdown: count });
        SoundEngine.countTick(count);
      }
    }, 1000);
  }, [syncUi]);

  // ── Online: enter matchmaking queue ─────────────────────────────────────────
  const openMatchmaking = useCallback(() => {
    syncUi({ phase: "online-matchmaking", onlineError: "", opponentNickname: "",
              rematchState: "idle", myRematchVote: false, opponentRematchVote: false });
  }, [syncUi]);

  const handleJoinQueue = useCallback(async (nickname) => {
    syncUi({ onlineNickname: nickname, onlineError: "" });

    // Request mic first — non-blocking, player can play muted if denied
    if (micStatusRef.current === "idle") {
      micStatusRef.current = "requesting";
      syncUi({ micStatus: "requesting" });
      const result = await VoiceEngine.requestMic();
      micStatusRef.current = result;
      syncUi({ micStatus: result,
                onlineError: result === "denied"
                  ? "⚠️ Mic denied — you'll play muted (voice chat unavailable)"
                  : result === "unavailable"
                  ? "⚠️ No mic found — playing muted"
                  : "" });
    }

    if (!SocketManager.isAvailable()) {
      syncUi({
        phase: "online-searching",
        onlineError: "⚠️ Server not connected — matchmaking unavailable",
      });
      return;
    }

    SocketManager.connect(
      nickname,
      () => {
        syncUi({ phase: "online-searching", socketConnected: true });
        SocketManager.joinQueue(nickname);
      },
      (err) => syncUi({ onlineError: `Connection failed: ${err}` }),
    );
  }, [syncUi]);

  const handleCancelQueue = useCallback(() => {
    SocketManager.leaveQueue();
    SocketManager.disconnect();
    VoiceEngine.hangup();
    syncUi({ phase: "menu", onlineError: "", micStatus: "idle",
              voiceStatus: "off", camOff: false });
  }, [syncUi]);

  // ── Rematch callbacks ────────────────────────────────────────────────────────
  const handleRematch = useCallback(() => {
    playSound("rematch");
    syncUi({ myRematchVote: true, rematchState: "waiting" });
    SocketManager.voteRematch();
  }, [syncUi]);

  const handleFindAnother = useCallback(() => {
    VoiceEngine.hangup();
    SocketManager.findAnother();
    syncUi({ phase: "online-searching", rematchState: "idle",
              myRematchVote: false, opponentRematchVote: false,
              micStatus: micStatusRef.current, voiceStatus: "off" });
  }, [syncUi]);

  const handleExitOnline = useCallback(() => {
    VoiceEngine.hangup();
    SocketManager.disconnect();
    syncUi({ phase: "menu", rematchState: "idle", micStatus: "idle",
              voiceStatus: "off", camOff: false });
  }, [syncUi]);

  // ── Online: socket event listeners ─────────────────────────────────────────
  useEffect(() => {
    if (!SocketManager.isAvailable()) return;

    SocketManager.on("match_found", ({ opponentNickname, isInitiator }) => {
      syncUi({ phase: "online-found", opponentNickname, voiceStatus: "connecting" });
      playSound("matchFound");
      // Give React a tick to mount the remote <video> element before starting WebRTC
      setTimeout(() => {
        // Re-wire the video element ref in case it wasn't available before
        VoiceEngine.setRemoteVideoEl(remoteVideoRef.current);
        VoiceEngine.startCall(isInitiator).then(() => {
          syncUi({ voiceStatus: micStatusRef.current === "granted" ? "active" : "off" });
        });
      }, 200);
    });

    // ── WebRTC signalling relay (standardised webrtc_ names) ─────────────────
    SocketManager.on("webrtc_offer",         ({ sdp }) => VoiceEngine.handleOffer(sdp));
    SocketManager.on("webrtc_answer",        ({ sdp }) => VoiceEngine.handleAnswer(sdp));
    SocketManager.on("webrtc_ice_candidate", ({ candidate }) => VoiceEngine.handleIce(candidate));

    SocketManager.on("countdown_tick", ({ count }) => {
      syncUi({ phase: "online-countdown", countdown: count });
      SoundEngine.countTick(count);
    });

    SocketManager.on("match_start", () => {
      const game = gameRef.current;
      game.score = 0; game.repState = { left: "idle", right: "idle" };
      game.phase = "online-playing"; game.timeLeft = GAME_DURATION;
      game.combo = 0; game.lastComboTime = 0;
      syncUi({ phase: "online-playing", gameMode: "online",
                score: 0, opponentScore: 0, timeLeft: GAME_DURATION });
      SoundEngine.matchStart();
      // Re-wire the remote video element — the split-screen panel mounts on this phase
      setTimeout(() => VoiceEngine.setRemoteVideoEl(remoteVideoRef.current), 100);
      timerRef.current = setInterval(() => {
        game.timeLeft--;
        syncUi({ timeLeft: game.timeLeft });
        if (game.timeLeft <= 3 && game.timeLeft > 0) playSound("timerWarn");
      }, 1000);
    });

    SocketManager.on("opponent_rep", ({ score }) => {
      syncUi({ opponentScore: score });
    });

    SocketManager.on("match_end", ({ winner, scores }) => {
      clearInterval(timerRef.current);
      gameRef.current.phase = "done";
      syncUi({
        phase: "winner",
        score:         scores.local    ?? 0,
        opponentScore: scores.opponent ?? 0,
        isWinner:      winner === "local",
        rematchState:  "idle",
        myRematchVote: false,
        opponentRematchVote: false,
      });
      SoundEngine.matchEnd();
      if (winner === "local") playSound("victory");
      else if (winner === "opponent") playSound("defeat");
    });

    // ── Rematch events ────────────────────────────────────────────────────────
    // Opponent voted for rematch
    SocketManager.on("opponent_rematch_vote", () => {
      syncUi({ opponentRematchVote: true });
    });

    // Both voted — server restarts countdown (reuses countdown_tick / match_start)
    SocketManager.on("rematch_starting", () => {
      playSound("rematch");
      const game = gameRef.current;
      game.score = 0; game.repState = { left: "idle", right: "idle" };
      game.combo = 0; game.lastComboTime = 0;
      syncUi({ rematchState: "restarting", score: 0, opponentScore: 0,
                myRematchVote: false, opponentRematchVote: false });
    });

    // Opponent chose "Find Another" instead of rematch
    SocketManager.on("opponent_declined_rematch", () => {
      syncUi({ rematchState: "opponent-left",
                onlineError: "Opponent found a new match." });
    });

    SocketManager.on("opponent_left", () => {
      clearInterval(timerRef.current);
      VoiceEngine.hangup();
      syncUi({ rematchState: "opponent-left",
                onlineError: "Opponent disconnected.",
                voiceStatus: "off" });
    });

    return () => {
      ["match_found","webrtc_offer","webrtc_answer","webrtc_ice_candidate",
       "countdown_tick","match_start","opponent_rep","match_end",
       "opponent_rematch_vote","rematch_starting","opponent_declined_rematch",
       "opponent_left"].forEach(SocketManager.off);
    };
  }, [syncUi]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  // ── Save nickname + score → leaderboard ────────────────────────────────────
  const saveNickname = useCallback((nickname) => {
    const pending = pendingEntryRef.current;
    if (!pending) return;
    const entries = Leaderboard.addEntry(nickname, pending.score);
    pendingEntryRef.current = null;
    syncUi({ phase: "leaderboard", lbEntries: entries, lbLatestDate: pending.date,
              score: pending.score });
  }, [syncUi]);

  // ── Skip nickname (just view leaderboard without saving) ───────────────────
  const skipNickname = useCallback(() => {
    const pending = pendingEntryRef.current;
    const entries = Leaderboard.load();
    syncUi({ phase: "leaderboard", lbEntries: entries, lbLatestDate: null,
              score: pending?.score ?? ui.score });
  }, [syncUi, ui.score]);

  // ── Open leaderboard from idle screen ──────────────────────────────────────
  const openLeaderboard = useCallback(() => {
    const entries = Leaderboard.load();
    syncUi({ phase: "leaderboard", lbEntries: entries, lbLatestDate: null });
  }, [syncUi]);

  // ── Destructure UI for render ──────────────────────────────────────────────
  const {
    phase, score, timeLeft, poseReady, armState,
    lastRep, combo, comboTier, showCombo,
    countdown, scoreAnimate,
    screenFlash, screenShake, showRing, showPlusOne,
    lbEntries, lbLatestDate,
    gameMode, onlineNickname,
    opponentNickname, opponentScore, onlineError,
    micStatus, micMuted, voiceStatus, camOff,
    rematchState, myRematchVote, opponentRematchVote,
    serverStatus,
  } = ui;

  const timerUrgent  = timeLeft <= 3;
  const timerWarning = timeLeft <= 5 && !timerUrgent;
  const leftRaised   = armState.left  === "raised";
  const rightRaised  = armState.right === "raised";
  const result       = getResultMessage(score);

  // Set browser tab title
  useEffect(() => { document.title = "67Arena — Fight with your arms"; }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Scanline overlay */}
      <div className="arena-scanline" />

      <div className="arena-page">
        <div className="arena-root" style={{
          animation: screenShake ? "arena-screenshake 0.28s ease" : "none",
        }}>
        {/* Hidden video source for MediaPipe — always present */}
        <video ref={videoRef} style={S.hiddenVideo} playsInline muted />

        {/* ── Video layer: solo = full canvas; online = split 50/50 ── */}
        {phase === "online-playing" || phase === "online-countdown" ? (
          // Online: local (left) + opponent (right) side-by-side
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "row",
          }}>
            {/* Local player — left half, mirrored canvas */}
            <div style={{ flex: 1, position: "relative", overflow: "hidden",
                          borderRight: "1px solid rgba(255,98,0,0.3)" }}>
              <canvas ref={canvasRef} width={640} height={480} style={{
                ...S.canvas,
                width: "100%", height: "100%",
              }} />
              {/* Local label */}
              <div style={S.videoLabel}>
                <span style={S.videoLabelText}>
                  {camOff ? "📷 CAM OFF" : "YOU"}
                </span>
              </div>
            </div>
            {/* Opponent — right half, raw WebRTC video */}
            <div style={{ flex: 1, position: "relative", overflow: "hidden",
                          background: "#0a0a0f" }}>
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                style={{
                  width: "100%", height: "100%",
                  objectFit: "cover",
                  transform: "scaleX(-1)",  // mirror opponent feed
                }}
              />
              {/* Opponent label */}
              <div style={{ ...S.videoLabel, right: 0, left: "auto" }}>
                <span style={S.videoLabelText}>{opponentNickname || "OPPONENT"}</span>
              </div>
            </div>
          </div>
        ) : (
          // Solo / other phases: full-width canvas as before
          <canvas ref={canvasRef} width={640} height={480} style={S.canvas} />
        )}

        {/* Vignette */}
        <div style={S.vignette} />

        {/* ── Rep flash overlay — orange burst on score ─────────────────────── */}
        {screenFlash && (
          <div style={{
            position: "absolute", inset: 0, pointerEvents: "none", zIndex: 10,
            background: "radial-gradient(ellipse at center, rgba(255,98,0,0.28) 0%, transparent 70%)",
            animation: "arena-repflash 0.38s ease-out forwards",
          }} />
        )}

        {/* ── Expanding ring — radiates from the scored arm side ───────────── */}
        {showRing && (
          <div style={{
            position: "absolute",
            top: "50%", left: showRing === "left" ? "25%" : "75%",
            width: 60, height: 60,
            marginTop: -30, marginLeft: -30,
            borderRadius: "50%",
            border: `2px solid ${comboTier?.color ?? "#ff6200"}`,
            pointerEvents: "none", zIndex: 11,
            animation: "arena-ring 0.45s ease-out forwards",
            boxShadow: `0 0 12px ${comboTier?.color ?? "#ff6200"}`,
          }} />
        )}

        {/* ── Floating +1 chip ─────────────────────────────────────────────── */}
        {showPlusOne && (
          <div style={{
            position: "absolute",
            top: "38%", left: "50%",
            transform: "translateX(-50%)",
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 900,
            fontSize: "clamp(18px, 3vw, 28px)",
            color: comboTier?.color ?? "#ff6200",
            textShadow: `0 0 16px ${comboTier?.color ?? "#ff6200"}`,
            pointerEvents: "none", zIndex: 12,
            animation: "arena-plusone 0.55s ease-out forwards",
          }}>
            +1
          </div>
        )}

        {/* ── HUD ─────────────────────────────────────────────────────────── */}
        <div style={S.hud}>

          {/* Only show score/timer/combo/arms during active gameplay phases */}
          {(() => {
            const showGameplayHud =
              phase === "countdown"        ||
              phase === "playing"          ||
              phase === "online-countdown" ||
              phase === "online-playing";

            return showGameplayHud ? (
              <>
                {/* Top bar — REPS · Logo · TIME */}
                <div style={{
                  ...S.topBar,
                  animation: (phase === "playing" || phase === "online-playing")
                    ? "arena-hudbreathe 2s ease-in-out infinite" : "none",
                }}>
                  {/* Score block */}
                  <div style={S.hudBlock}>
                    <span className="arena-hud-label" style={S.hudLabel}>REPS</span>
                    <span className="arena-hud-value" style={{
                      ...S.hudValue,
                      color: lastRep ? "#ff6200" : "#ffffff",
                      textShadow: lastRep ? "0 0 24px #ff6200, 0 0 48px #ff620066" : "none",
                      animation: scoreAnimate ? "arena-scorebounce 0.42s cubic-bezier(0.34,1.56,0.64,1)" : "none",
                      display: "inline-block",
                      transition: "color 0.15s, text-shadow 0.15s",
                    }}>
                      {score}
                    </span>
                  </div>

                  {/* Animated logo */}
                  <div style={S.logo}>
                    <span className="arena-logo-67" style={S.logo67}>67</span>
                    <span className="arena-logo-text" style={S.logoArena}>ARENA</span>
                  </div>

                  {/* Timer block */}
                  <div style={{ ...S.hudBlock, textAlign: "right" }}>
                    <span className="arena-hud-label" style={S.hudLabel}>TIME</span>
                    <span className="arena-hud-value" style={{
                      ...S.hudValue,
                      fontVariantNumeric: "tabular-nums",
                      display: "inline-block",
                      animation: timerUrgent
                        ? "arena-heartbeat 0.6s ease-in-out infinite"
                        : timerWarning
                        ? "arena-timewarn 1s ease-in-out infinite"
                        : "none",
                      color: timerUrgent ? "#ff2200"
                           : timerWarning ? "#ff9500"
                           : "#ffffff",
                      textShadow: timerUrgent
                        ? "0 0 30px #ff220099, 0 0 60px #ff000055"
                        : timerWarning
                        ? "0 0 20px #ff950066"
                        : "none",
                    }}>
                      {timeLeft}
                      <span style={{ fontSize: "0.4em", color: "rgba(255,255,255,0.5)" }}>s</span>
                    </span>
                  </div>
                </div>

                {/* Combo badge */}
                {showCombo && comboTier && (
                  <div style={{
                    ...S.comboBadge,
                    background: `${comboTier.color}18`,
                    border: `1.5px solid ${comboTier.color}`,
                    boxShadow: `0 0 20px ${comboTier.color}55, inset 0 0 12px ${comboTier.color}22`,
                    animation: "arena-comboenter 0.3s cubic-bezier(0.34,1.56,0.64,1)",
                  }}>
                    <span style={{
                      color: comboTier.color, letterSpacing: 4,
                      fontFamily: "'Barlow Condensed', sans-serif",
                      fontWeight: 700, fontSize: "clamp(8px,1.1vw,11px)",
                      textShadow: `0 0 10px ${comboTier.color}`,
                    }}>
                      {comboTier.label}
                    </span>
                    <span style={{
                      color: "#ffffff", fontWeight: 900, lineHeight: 1,
                      fontFamily: "'Barlow Condensed', sans-serif",
                      fontSize: "clamp(20px,3.5vw,30px)",
                      textShadow: `0 0 20px ${comboTier.color}aa`,
                    }}>
                      ×{combo}
                    </span>
                  </div>
                )}

                {/* Arm state indicators */}
                {(phase === "playing" || phase === "online-playing") && (
                  <div style={S.armRow}>
                    <ArmChip side="L" raised={leftRaised}  scored={lastRep === "left"} />
                    <div style={S.armDivider} />
                    <ArmChip side="R" raised={rightRaised} scored={lastRep === "right"} />
                  </div>
                )}

                {/* Online opponent HUD strip */}
                {phase === "online-playing" && (
                  <div style={S.onlineHudStrip}>
                    <div style={S.onlinePlayerChip}>
                      <span style={S.onlineChipName}>{onlineNickname || "YOU"}</span>
                      <span style={{ ...S.onlineChipScore, color: "#ff6200" }}>{score}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column",
                                  alignItems: "center", gap: 3 }}>
                      <div style={S.onlineVs}>VS</div>
                      {/* Mute button */}
                      <button
                        onClick={() => {
                          const next = !micMuted;
                          VoiceEngine.setMuted(next);
                          syncUi({ micMuted: next });
                        }}
                        style={{
                          ...S.muteBtn,
                          background: micMuted ? "rgba(255,50,50,0.2)" : "rgba(255,98,0,0.15)",
                          border: `1px solid ${micMuted ? "#ff3333" : "#ff6200"}`,
                          color:  micMuted ? "#ff4444" : "#ff6200",
                          pointerEvents: "all",
                        }}
                        title={micMuted ? "Unmute mic" : "Mute mic"}
                      >
                        {micMuted ? "🔇" : "🎙️"}
                      </button>
                      {/* Camera toggle */}
                      {VoiceEngine.hasVideo() && (
                        <button
                          onClick={() => {
                            const next = !camOff;
                            VoiceEngine.setCamOff(next);
                            syncUi({ camOff: next });
                          }}
                          style={{
                            ...S.muteBtn,
                            background: camOff ? "rgba(255,50,50,0.2)" : "rgba(255,98,0,0.15)",
                            border: `1px solid ${camOff ? "#ff3333" : "#ff6200"}`,
                            color: camOff ? "#ff4444" : "#ff6200",
                            pointerEvents: "all",
                          }}
                          title={camOff ? "Turn camera on" : "Turn camera off"}
                        >
                          {camOff ? "📷" : "🎥"}
                        </button>
                      )}
                    </div>
                    <div style={{ ...S.onlinePlayerChip, textAlign: "right" }}>
                      <span style={S.onlineChipName}>{opponentNickname || "OPPONENT"}</span>
                      <span style={S.onlineChipScore}>{opponentScore}</span>
                    </div>
                  </div>
                )}
              </>
            ) : null;
          })()}

          {/* ── Phase overlays ──────────────────────────────────────────── */}

          {/* MAIN MENU */}
          {phase === "menu" && (
            <GlassOverlay>
              {!poseReady ? (
                <LoadingScreen />
              ) : (
                <MainMenuScreen
                  onSolo={() => syncUi({ phase: "solo" })}
                  onOnline={openMatchmaking}
                  onLeaderboard={openLeaderboard}
                />
              )}
            </GlassOverlay>
          )}

          {/* SOLO MODE SELECT */}
          {phase === "solo" && (
            <GlassOverlay>
              <SoloMenuScreen
                onStart={startSoloGame}
                onLeaderboard={openLeaderboard}
                onBack={() => syncUi({ phase: "menu" })}
              />
            </GlassOverlay>
          )}

          {/* COUNTDOWN (solo) */}
          {phase === "countdown" && (
            <GlassOverlay>
              <CountdownScreen count={countdown} />
            </GlassOverlay>
          )}

          {/* MATCH OVER fallback */}
          {phase === "done" && (
            <GlassOverlay>
              <ResultScreen score={score} result={result} onReplay={startSoloGame} onLeaderboard={openLeaderboard} />
            </GlassOverlay>
          )}

          {/* NICKNAME ENTRY */}
          {phase === "nickname" && (
            <GlassOverlay>
              <NicknameScreen score={score} onSave={saveNickname} onSkip={skipNickname} />
            </GlassOverlay>
          )}

          {/* LEADERBOARD */}
          {phase === "leaderboard" && (
            <GlassOverlay wide>
              <LeaderboardScreen
                entries={lbEntries}
                latestDate={lbLatestDate}
                onPlay={startSoloGame}
                onBack={() => syncUi({ phase: "menu" })}
              />
            </GlassOverlay>
          )}

          {/* ── ONLINE PHASES ─────────────────────────────────────────────── */}

          {/* MATCHMAKING ENTRY — nickname input */}
          {phase === "online-matchmaking" && (
            <GlassOverlay>
              <MatchmakingEntryScreen
                onJoinQueue={handleJoinQueue}
                onBack={() => { playSound("click"); syncUi({ phase: "menu" }); }}
                error={onlineError}
                serverStatus={serverStatus}
              />
            </GlassOverlay>
          )}

          {/* SEARCHING — animated queue screen */}
          {phase === "online-searching" && (
            <GlassOverlay>
              <SearchingScreen
                nickname={onlineNickname}
                onCancel={handleCancelQueue}
                error={onlineError}
                serverStatus={serverStatus}
              />
            </GlassOverlay>
          )}

          {/* MATCH FOUND — brief reveal before countdown */}
          {phase === "online-found" && (
            <GlassOverlay>
              <MatchFoundScreen
                myNickname={onlineNickname}
                opponentNickname={opponentNickname}
              />
            </GlassOverlay>
          )}

          {/* ONLINE COUNTDOWN — server-synced 3-2-1 */}
          {phase === "online-countdown" && (
            <GlassOverlay>
              <CountdownScreen count={countdown} />
            </GlassOverlay>
          )}

          {/* WINNER SCREEN */}
          {phase === "winner" && (
            <GlassOverlay wide>
              <WinnerScreen
                myNickname={onlineNickname}
                myScore={score}
                opponentNickname={opponentNickname}
                opponentScore={opponentScore}
                rematchState={rematchState}
                myVote={myRematchVote}
                opponentVote={opponentRematchVote}
                onlineError={onlineError}
                onRematch={handleRematch}
                onFindAnother={handleFindAnother}
                onExit={handleExitOnline}
              />
            </GlassOverlay>
          )}

          {/* Loading progress bar */}
          {!poseReady && phase === "idle" && (
            <div style={S.loadTrack}>
              <div style={S.loadFill} />
            </div>
          )}
        </div>{/* end HUD */}
        </div>{/* end arena-root */}
      </div>{/* end arena-page */}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Glassmorphism overlay wrapper — pass wide={true} for leaderboard */
function GlassOverlay({ children, wide }) {
  return (
    <div style={S.overlayWrap}>
      <div
        className={wide ? "arena-glass-card arena-glass-card--wide" : "arena-glass-card"}
        style={S.glassCard}
      >
        {children}
      </div>
    </div>
  );
}

/** Pulsing loading screen */
function LoadingScreen() {
  return (
    <>
      <Logo67 size="md" />
      <div style={S.spinner} />
      <p className="arena-overlay-sub" style={S.overlaySubtitle}>Initialising arena…</p>
      <p className="arena-overlay-hint" style={S.overlayHint}>Allow camera access when prompted</p>
    </>
  );
}

/** Ready-to-play screen */
function ReadyScreen({ onStart, onLeaderboard }) {
  return (
    <>
      <Logo67 size="lg" />
      <p className="arena-overlay-sub" style={S.overlaySubtitle}>
        Raise either arm above your shoulder<br />
        and lower it to score a rep
      </p>
      <p className="arena-overlay-hint" style={S.overlayHint}>10 seconds · Both arms tracked · Combos rewarded</p>
      <ArenaButton onClick={onStart}>ENTER THE ARENA</ArenaButton>
      <button onClick={onLeaderboard} style={S.ghostBtn}>🏆 VIEW RANKING</button>
    </>
  );
}

/** Dramatic 3-2-1 countdown */
function CountdownScreen({ count }) {
  const label = count === 0 ? "GO!" : String(count);
  const isGo  = count === 0;
  // Each number gets a unique accent so the eye tracks the change
  const tickColor = count === 3 ? "#ffffff" : count === 2 ? "#ff9500" : count === 1 ? "#ff4400" : "#ff6200";
  return (
    <>
      {/* GO! gets a special explosive animation; numbers use the spring scale */}
      <p className="arena-countdown-big" style={{
        ...S.countdownBig,
        color: tickColor,
        filter: isGo
          ? "drop-shadow(0 0 40px #ff6200) drop-shadow(0 0 80px #ff000088)"
          : `drop-shadow(0 0 20px ${tickColor}88)`,
        animation: isGo
          ? "arena-go 0.55s cubic-bezier(0.22,1.2,0.36,1)"
          : "arena-countscale 0.5s cubic-bezier(0.34,1.56,0.64,1)",
        // key trick: animating on every count change requires a wrapper key in parent,
        // but we force re-animation via unique key on the element via the parent remount
      }}>
        {label}
      </p>
      <p className="arena-overlay-sub" style={{
        ...S.overlaySubtitle,
        color: isGo ? "#ff9500" : "rgba(255,255,255,0.65)",
        fontWeight: isGo ? 700 : 400,
        letterSpacing: isGo ? "0.3em" : 0,
        animation: isGo ? "arena-logorise 0.4s ease" : "none",
      }}>
        {count >= 3 ? "GET READY…"
         : count === 2 ? "ARMS UP…"
         : count === 1 ? "LAST CHANCE…"
         : "FIGHT!"}
      </p>
    </>
  );
}

/** Result / victory screen */
function ResultScreen({ score, result, onReplay, onLeaderboard }) {
  const isLegendary = score >= 13;
  return (
    <>
      {isLegendary && <div style={S.victoryRays} />}
      <p style={{ ...S.overlayLabel, color: "#ff6200" }}>MATCH OVER</p>
      <Logo67 size="sm" />
      <div style={S.resultScoreWrap}>
        <span className="arena-result-score" style={S.resultScore}>{score}</span>
        <span style={S.resultScoreLabel}>reps</span>
      </div>
      <p className="arena-overlay-title" style={{
        ...S.overlayTitle,
        color: isLegendary ? "#ff6200" : "#ffffff",
        animation: isLegendary ? "arena-glow 1.5s ease-in-out infinite" : "none",
      }}>
        {result.title}
      </p>
      <p className="arena-overlay-sub" style={S.overlaySubtitle}>{result.sub}</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        <ArenaButton onClick={onReplay}>PLAY AGAIN</ArenaButton>
        {onLeaderboard && <button onClick={onLeaderboard} style={S.ghostBtn}>🏆 RANKING</button>}
      </div>
    </>
  );
}

/** Nickname entry — shown after every match before saving score */
function NicknameScreen({ score, onSave, onSkip }) {
  const [name, setName] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSave = () => { if (name.trim()) onSave(name); else onSkip(); };
  const handleKey  = (e) => { if (e.key === "Enter") handleSave(); };

  return (
    <>
      <p style={{ ...S.overlayLabel, color: "#ff6200" }}>MATCH OVER</p>
      <div style={S.resultScoreWrap}>
        <span className="arena-result-score" style={S.resultScore}>{score}</span>
        <span style={S.resultScoreLabel}>reps</span>
      </div>
      <p className="arena-overlay-sub" style={{ ...S.overlaySubtitle, marginBottom: 4 }}>
        Enter your nickname to save this score
      </p>
      <input
        ref={inputRef}
        value={name}
        onChange={e => setName(e.target.value.slice(0, 16))}
        onKeyDown={handleKey}
        placeholder="YOUR NAME"
        maxLength={16}
        style={S.nicknameInput}
        spellCheck={false}
        autoComplete="off"
      />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        <ArenaButton onClick={handleSave}>SAVE SCORE</ArenaButton>
        <button onClick={onSkip} style={S.ghostBtn}>SKIP</button>
      </div>
    </>
  );
}

/** Leaderboard — top 10, highlights latest entry */
function LeaderboardScreen({ entries, latestDate, onPlay, onBack }) {
  const medals = ["🥇", "🥈", "🥉"];
  const empty  = entries.length === 0;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    width: "100%", marginBottom: 2 }}>
        <Logo67 size="sm" />
        <p style={{ ...S.overlayLabel, color: "#ff6200", margin: 0 }}>HALL OF FAME</p>
      </div>

      {empty ? (
        <p className="arena-overlay-sub" style={{ ...S.overlaySubtitle, opacity: 0.5, padding: "16px 0" }}>
          No scores yet — be the first!
        </p>
      ) : (
        <div style={S.lbTable}>
          {/* Header */}
          <div style={{ ...S.lbRow, ...S.lbHeader }}>
            <span style={S.lbRank}>#</span>
            <span style={S.lbName}>PLAYER</span>
            <span style={S.lbScore}>REPS</span>
            <span style={S.lbDate}>DATE</span>
          </div>

          {entries.map((entry, i) => {
            const isLatest  = latestDate && entry.date === latestDate;
            const dateStr   = new Date(entry.date).toLocaleDateString(undefined,
              { month: "short", day: "numeric" });
            return (
              <div key={entry.date} style={{
                ...S.lbRow,
                background: isLatest
                  ? "rgba(255,98,0,0.12)"
                  : i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
                border: isLatest
                  ? "1px solid rgba(255,98,0,0.4)"
                  : "1px solid transparent",
                borderRadius: 8,
                animation: isLatest ? "arena-pop 0.5s ease" : "none",
              }}>
                <span style={{ ...S.lbRank, color: i < 3 ? "#ff6200" : "rgba(255,255,255,0.35)" }}>
                  {i < 3 ? medals[i] : i + 1}
                </span>
                <span style={{
                  ...S.lbName,
                  color: isLatest ? "#ff9500" : "#ffffff",
                  fontWeight: isLatest ? 700 : 400,
                }}>
                  {entry.nickname}
                  {isLatest && <span style={{ color: "#ff6200", fontSize: "0.75em",
                    marginLeft: 6 }}>◀ YOU</span>}
                </span>
                <span style={{
                  ...S.lbScore,
                  color: i === 0 ? "#ff6200" : "#ffffff",
                  textShadow: i === 0 ? "0 0 12px #ff620066" : "none",
                }}>
                  {entry.score}
                </span>
                <span style={{ ...S.lbDate }}>{dateStr}</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", marginTop: 4 }}>
        <ArenaButton onClick={onPlay}>PLAY NOW</ArenaButton>
        <button onClick={onBack} style={S.ghostBtn}>← BACK</button>
      </div>
    </>
  );
}

/** Main menu — mode selector */
function MainMenuScreen({ onSolo, onOnline, onLeaderboard }) {
  return (
    <>
      <Logo67 size="lg" />
      <p className="arena-overlay-hint" style={S.overlayHint}>Choose your battle mode</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
        <ArenaButton onClick={onSolo}>⚡ SOLO MODE</ArenaButton>
        <ArenaButton onClick={onOnline}>🌐 1v1 ONLINE</ArenaButton>
      </div>
      <button onClick={onLeaderboard} style={S.ghostBtn}>🏆 RANKING</button>
    </>
  );
}

/** Solo mode screen — brief description + start */
function SoloMenuScreen({ onStart, onLeaderboard, onBack }) {
  return (
    <>
      <Logo67 size="md" />
      <p style={{ ...S.overlayLabel, color: "#ff6200" }}>SOLO MODE</p>
      <p className="arena-overlay-sub" style={S.overlaySubtitle}>
        Raise either arm above your shoulder<br />and lower it to score a rep
      </p>
      <p className="arena-overlay-hint" style={S.overlayHint}>
        10 seconds · Both arms · Combos rewarded
      </p>
      <ArenaButton onClick={onStart}>ENTER THE ARENA</ArenaButton>
      <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
        <button onClick={onLeaderboard} style={S.ghostBtn}>🏆 RANKING</button>
        <button onClick={onBack} style={S.ghostBtn}>← BACK</button>
      </div>
    </>
  );
}

/** Matchmaking entry — just nickname, then queue. Shows live server status. */
function MatchmakingEntryScreen({ onJoinQueue, onBack, error, serverStatus }) {
  const [nickname, setNickname] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // ── Single source of truth ─────────────────────────────────────────────────
  const serverConfigured = Boolean(SOCKET_URL);
  const serverConnected  = serverConfigured && serverStatus === "connected";

  const canQueue    = nickname.trim().length >= 2;
  // Only block Find Match if the URL is genuinely absent
  const btnDisabled = !canQueue || !serverConfigured;

  // Status pill — only three real states
  const statusPill = serverConnected
    ? { dot: "#22cc66", text: "Server connected",      bg: "rgba(34,204,102,0.12)" }
    : serverConfigured
    ? { dot: "#ff9500", text: "Connecting to server…", bg: "rgba(255,149,0,0.1)"  }
    : { dot: "#ff4444", text: "Server not configured", bg: "rgba(255,68,68,0.1)"  };

  return (
    <>
      <p style={{ ...S.overlayLabel, color: "#ff6200" }}>1v1 ONLINE</p>
      <Logo67 size="md" />
      <p className="arena-overlay-sub" style={S.overlaySubtitle}>
        Enter your name and find an opponent
      </p>

      {/* Live server status pill */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 12px", borderRadius: 20,
        background: statusPill.bg,
        border: `1px solid ${statusPill.dot}44`,
        alignSelf: "center",
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%",
          background: statusPill.dot,
          boxShadow: serverConnected ? `0 0 6px ${statusPill.dot}` : "none",
          animation: serverConfigured && !serverConnected ? "arena-pulse 1s infinite" : "none",
          flexShrink: 0,
        }} />
        <span style={{
          fontFamily: "'Barlow Condensed', sans-serif",
          fontSize: "clamp(9px,1.2vw,11px)",
          color: statusPill.dot,
          letterSpacing: "0.1em",
        }}>
          {statusPill.text}
        </span>
      </div>

      <input
        ref={inputRef}
        value={nickname}
        onChange={e => setNickname(e.target.value.slice(0, 16))}
        onKeyDown={e => e.key === "Enter" && canQueue && serverConfigured && onJoinQueue(nickname.trim())}
        placeholder="YOUR NICKNAME"
        style={S.nicknameInput}
        autoComplete="off"
        maxLength={16}
        spellCheck={false}
      />
      {error && (
        <p style={{ margin: 0, fontSize: "clamp(10px,1.4vw,12px)",
                    color: serverConfigured ? "#ff9500" : "#ff4444", textAlign: "center" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
        <ArenaButton
          disabled={btnDisabled}
          onClick={() => canQueue && serverConfigured && onJoinQueue(nickname.trim())}
        >
          {serverConfigured ? "FIND MATCH" : "SERVER OFFLINE"}
        </ArenaButton>
        <button onClick={() => { playSound("click"); onBack(); }} style={S.ghostBtn}>← BACK</button>
      </div>
      <p className="arena-overlay-hint" style={S.overlayHint}>
        Automatic matchmaking — no room codes
      </p>
    </>
  );
}

/** Searching — animated "looking for opponent" screen */
function SearchingScreen({ nickname, onCancel, error, serverStatus }) {
  const [dots, setDots] = useState(0);
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const d = setInterval(() => setDots(p => (p + 1) % 4), 500);
    const s = setInterval(() => setSecs(p => p + 1), 1000);
    return () => { clearInterval(d); clearInterval(s); };
  }, []);

  // Only surface an error if the socket actually dropped — not just because
  // the player just entered the queue (socket may still be connecting)
  const showError = error && serverStatus === "disconnected";

  return (
    <>
      <p style={{ ...S.overlayLabel, color: "#ff6200" }}>MATCHMAKING</p>
      <Logo67 size="sm" />

      {/* Animated radar/pulse ring stack */}
      <div style={S.radarWrap}>
        <div style={S.radarRing1} />
        <div style={S.radarRing2} />
        <div style={S.radarRing3} />
        <div style={S.radarCore}>⚡</div>
      </div>

      <p className="arena-overlay-title" style={{
        ...S.overlayTitle,
        fontSize: "clamp(16px,2.5vw,22px)",
        color: "#ffffff",
        fontWeight: 700,
        letterSpacing: "0.1em",
      }}>
        SEARCHING{".".repeat(dots)}
      </p>
      <p className="arena-overlay-sub" style={{ ...S.overlaySubtitle, color: "#ff9500" }}>
        {nickname} · {secs}s in queue
      </p>
      {showError && (
        <p style={{ margin: 0, fontSize: "clamp(10px,1.4vw,12px)",
                    color: "#ff4444", textAlign: "center" }}>{error}</p>
      )}
      <button onClick={() => { playSound("click"); onCancel(); }} style={S.ghostBtn}>CANCEL</button>
    </>
  );
}

/** Match found — brief reveal before countdown fires */
function MatchFoundScreen({ myNickname, opponentNickname }) {
  return (
    <>
      <p style={{ ...S.overlayLabel, color: "#ff6200", animation: "arena-glow 1s infinite" }}>
        MATCH FOUND!
      </p>
      <div style={S.onlineScoreCompare}>
        <div style={{ textAlign: "center", animation: "arena-pop 0.4s ease" }}>
          <div style={{ fontSize: "clamp(22px,4vw,36px)" }}>⚡</div>
          <div style={{ ...S.onlineChipName, color: "#ff6200",
                        fontSize: "clamp(14px,2.2vw,20px)" }}>
            {myNickname || "YOU"}
          </div>
        </div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900,
                      fontSize: "clamp(18px,3vw,28px)", color: "rgba(255,98,0,0.6)",
                      letterSpacing: 4 }}>VS</div>
        <div style={{ textAlign: "center", animation: "arena-pop 0.4s 0.15s ease both" }}>
          <div style={{ fontSize: "clamp(22px,4vw,36px)" }}>⚡</div>
          <div style={{ ...S.onlineChipName, fontSize: "clamp(14px,2.2vw,20px)" }}>
            {opponentNickname || "OPPONENT"}
          </div>
        </div>
      </div>
      <p className="arena-overlay-sub" style={{ ...S.overlaySubtitle, color: "#ff9500",
                                                animation: "arena-pulse 0.8s infinite" }}>
        Get ready…
      </p>
    </>
  );
}

/** Full post-match result + rematch screen */
function WinnerScreen({ myNickname, myScore, opponentNickname, opponentScore,
                        rematchState, myVote, opponentVote, onlineError,
                        onRematch, onFindAnother, onExit }) {
  const iWon  = myScore > opponentScore;
  const tied  = myScore === opponentScore;
  const opponentLeft = rematchState === "opponent-left";

  const outcomeLabel = tied  ? "DRAW"    : iWon ? "VICTORY"  : "DEFEAT";
  const outcomeColor = tied  ? "#ff9500" : iWon ? "#ff6200"  : "rgba(255,255,255,0.55)";

  return (
    <>
      {iWon && <div style={S.victoryRays} />}

      {/* Outcome headline */}
      <p className="arena-overlay-title" style={{
        ...S.overlayTitle,
        fontSize: "clamp(28px,5vw,48px)",
        color: outcomeColor,
        animation: iWon ? "arena-glow 1.5s ease-in-out infinite" : "none",
        letterSpacing: "0.12em",
        margin: 0,
      }}>
        {outcomeLabel}
      </p>

      {/* Scoreboard */}
      <div style={S.postMatchBoard}>
        {/* My row */}
        <div style={{ ...S.boardRow, borderColor: "#ff6200" }}>
          <span style={{ ...S.boardName, color: "#ff6200" }}>{myNickname || "YOU"}</span>
          <span style={{ ...S.boardScore, color: "#ff6200",
                         filter: "drop-shadow(0 0 10px rgba(255,98,0,0.6))" }}>
            {myScore}
          </span>
          {iWon && <span style={S.boardCrown}>🏆</span>}
        </div>

        <div style={{ color: "rgba(255,255,255,0.2)", fontFamily: "'Barlow Condensed'",
                      fontWeight: 900, fontSize: "clamp(12px,2vw,18px)",
                      letterSpacing: 4, textAlign: "center" }}>VS</div>

        {/* Opponent row */}
        <div style={{ ...S.boardRow, borderColor: !iWon && !tied ? "#ff9500" : "rgba(255,255,255,0.1)" }}>
          <span style={S.boardName}>{opponentNickname || "OPPONENT"}</span>
          <span style={{ ...S.boardScore, color: "#ffffff" }}>{opponentScore}</span>
          {!iWon && !tied && <span style={S.boardCrown}>🏆</span>}
        </div>
      </div>

      {/* Rematch status messages */}
      {opponentLeft && (
        <p style={{ margin: 0, fontSize: "clamp(10px,1.4vw,13px)",
                    color: "#ff9500", textAlign: "center" }}>
          {onlineError || "Opponent left the match."}
        </p>
      )}
      {rematchState === "waiting" && !opponentLeft && (
        <p style={{ margin: 0, fontSize: "clamp(10px,1.4vw,13px)",
                    color: "#ff9500", textAlign: "center",
                    animation: "arena-pulse 1s ease-in-out infinite" }}>
          Waiting for {opponentNickname || "opponent"}…
          {opponentVote ? " They're ready!" : ""}
        </p>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
        {!opponentLeft && (
          <ArenaButton
            onClick={onRematch}
            disabled={myVote}
          >
            {myVote ? (opponentVote ? "⚡ STARTING…" : "⏳ WAITING…") : "⚡ REMATCH"}
          </ArenaButton>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button onClick={onFindAnother} style={S.ghostBtn}>
            🔍 FIND ANOTHER
          </button>
          <button onClick={onExit} style={S.ghostBtn}>
            ✕ EXIT
          </button>
        </div>
      </div>
    </>
  );
}
function ArmChip({ side, raised, scored }) {
  return (
    <div style={{
      ...S.armChip,
      background: scored ? "rgba(255,98,0,0.35)"
                : raised ? "rgba(255,98,0,0.15)"
                : "rgba(0,0,0,0.3)",
      border: `1px solid ${raised || scored ? "#ff6200" : "rgba(255,255,255,0.12)"}`,
      transform: scored ? "scale(1.12)" : "scale(1)",
      animation: scored ? "arena-shake 0.2s ease" : "none",
    }}>
      <span className="arena-arm-label" style={{ letterSpacing: 3,
        color: raised ? "#ff6200" : "rgba(255,255,255,0.4)" }}>
        {side} ARM
      </span>
      <span className="arena-arm-arrow" style={{
        color: raised ? "#ff6200" : "rgba(255,255,255,0.2)",
        transition: "color 0.1s",
        filter: raised ? "drop-shadow(0 0 6px #ff6200)" : "none",
      }}>
        {raised ? "▲" : "▼"}
      </span>
      {raised && (
        <span className="arena-arm-label" style={{ color: "#ff9500", letterSpacing: 2, marginTop: -2 }}>
          RAISED
        </span>
      )}
    </div>
  );
}

/** Animated 67Arena logo */
function Logo67({ size = "md" }) {
  // Base sizes used as clamp minimums — CSS class handles the fluid scaling
  const numSizes = { sm: "clamp(20px,3.5vw,28px)", md: "clamp(28px,5vw,44px)", lg: "clamp(38px,7vw,58px)" };
  const txtSizes = { sm: "clamp(6px,0.8vw,9px)",  md: "clamp(7px,1vw,11px)", lg: "clamp(9px,1.3vw,13px)" };
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "0.2em", animation: "arena-logorise 0.5s ease" }}>
      <span style={{
        fontFamily: "'Barlow Condensed', sans-serif",
        fontWeight: 900,
        fontSize: numSizes[size],
        color: "#ff6200",
        lineHeight: 1,
        filter: "drop-shadow(0 0 12px rgba(255,98,0,0.7))",
        letterSpacing: -1,
      }}>67</span>
      <span style={{
        fontFamily: "'Barlow Condensed', sans-serif",
        fontWeight: 700,
        fontSize: txtSizes[size],
        color: "#ffffff",
        letterSpacing: "0.4em",
        lineHeight: 1,
        opacity: 0.9,
      }}>ARENA</span>
    </div>
  );
}

/** CTA button — plays click sound on press */
function ArenaButton({ onClick, children, disabled }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={() => { if (!disabled) { playSound("click"); onClick?.(); } }}
      onMouseEnter={() => { setHover(true);  playSound("hover"); }}
      onMouseLeave={() => { setHover(false); }}
      className="arena-btn"
      style={{
        marginTop: 8,
        background: disabled ? "rgba(255,98,0,0.15)" : hover ? "#ff6200" : "transparent",
        color:      disabled ? "rgba(255,98,0,0.4)"  : hover ? "#000000" : "#ff6200",
        border: `1.5px solid ${disabled ? "rgba(255,98,0,0.3)" : "#ff6200"}`,
        borderRadius: 6,
        fontWeight: 700,
        cursor:  disabled ? "not-allowed" : "pointer",
        fontFamily: "'Barlow Condensed', sans-serif",
        transition: "all 0.18s ease",
        boxShadow: disabled ? "none" : hover ? "0 0 30px rgba(255,98,0,0.6)" : "0 0 10px rgba(255,98,0,0.2)",
        pointerEvents: "all",
        textTransform: "uppercase",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const S = {
  // root is now handled by .arena-root CSS class (responsive breakpoints)
  // No fixed width/height here — all sizing lives in the injected stylesheet

  hiddenVideo: { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" },

  // objectFit: cover ensures camera fills container at any aspect ratio
  canvas: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" },

  vignette: {
    position: "absolute", inset: 0, pointerEvents: "none",
    background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.75) 100%)",
  },

  hud: {
    position: "absolute", inset: 0,
    display: "flex", flexDirection: "column",
    pointerEvents: "none",
  },

  // ── Top bar ──────────────────────────────────────────────────────────────────
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "clamp(8px,1.5vh,16px) clamp(10px,2vw,20px) clamp(6px,1vh,12px)",
    background: "linear-gradient(to bottom, rgba(0,0,0,0.88) 0%, transparent 100%)",
  },

  hudBlock: { display: "flex", flexDirection: "column", minWidth: "clamp(48px,8vw,80px)" },

  // Base fallbacks — fluid sizing applied via CSS class .arena-hud-label / .arena-hud-value
  hudLabel: {
    color: "rgba(255,255,255,0.4)",
    letterSpacing: "0.4em",
    fontWeight: 600,
    fontFamily: "'Barlow Condensed', sans-serif",
    textTransform: "uppercase",
  },

  hudValue: {
    fontWeight: 700,
    color: "#ffffff",
    lineHeight: 1,
    fontFamily: "'Barlow Condensed', sans-serif",
    display: "inline-block",
  },

  logo: { display: "flex", flexDirection: "column", alignItems: "center", gap: 0 },
  logo67: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 900, color: "#ff6200", lineHeight: 1,
    filter: "drop-shadow(0 0 8px rgba(255,98,0,0.8))",
    animation: "arena-glow 2.5s ease-in-out infinite",
  },
  logoArena: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700, color: "#ffffff", letterSpacing: "0.5em",
    opacity: 0.7, lineHeight: 1,
  },

  // ── Combo badge ───────────────────────────────────────────────────────────────
  comboBadge: {
    alignSelf: "center",
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: 2,
    padding: "clamp(4px,0.6vh,8px) clamp(12px,2vw,24px)",
    borderRadius: 8,
    backdropFilter: "blur(8px)",
    marginTop: 4,
    pointerEvents: "none",
  },

  // ── Arm row ───────────────────────────────────────────────────────────────────
  armRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "stretch",
    padding: "clamp(4px,0.6vh,8px) clamp(8px,1.5vw,16px)",
    gap: 8,
  },
  armChip: {
    flex: 1,
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: 2, padding: "clamp(6px,1vh,10px) 0",
    borderRadius: 10,
    backdropFilter: "blur(6px)",
    transition: "all 0.12s ease",
  },
  armDivider: { width: 1, alignSelf: "stretch", background: "rgba(255,255,255,0.08)" },

  // ── Overlays ──────────────────────────────────────────────────────────────────
  overlayWrap: {
    flex: 1, display: "flex",
    alignItems: "center", justifyContent: "center",
    pointerEvents: "all", padding: "clamp(10px,2vw,20px)",
  },
  // Padding + gap handled by .arena-glass-card CSS class (clamp)
  glassCard: {
    background: "rgba(5,5,10,0.84)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "clamp(10px,1.5vw,18px)",
    textAlign: "center",
    backdropFilter: "blur(20px)",
    display: "flex", flexDirection: "column",
    alignItems: "center",
    width: "100%",
    boxShadow: "0 0 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",
    animation: "arena-pop 0.45s cubic-bezier(0.34,1.56,0.64,1)",
    position: "relative", overflow: "hidden",
  },

  overlayLabel: {
    margin: 0, fontSize: "clamp(8px,1.1vw,11px)", fontWeight: 700, letterSpacing: "0.5em",
    fontFamily: "'Barlow Condensed', sans-serif", color: "rgba(255,255,255,0.5)",
  },
  overlayTitle: {
    margin: 0, fontWeight: 900, color: "#ffffff", letterSpacing: 1,
    fontFamily: "'Barlow Condensed', sans-serif",
  },
  overlaySubtitle: { margin: 0, color: "rgba(255,255,255,0.65)", lineHeight: 1.6 },
  overlayHint:     { margin: 0, color: "rgba(255,255,255,0.3)",  lineHeight: 1.5 },

  // font-size driven by .arena-countdown-big class
  countdownBig: {
    margin: 0, fontWeight: 900, lineHeight: 1,
    fontFamily: "'Barlow Condensed', sans-serif",
    filter: "drop-shadow(0 0 30px currentColor)",
  },

  // ── Result screen ─────────────────────────────────────────────────────────────
  resultScoreWrap: { display: "flex", alignItems: "baseline", gap: 6 },
  // font-size driven by .arena-result-score class
  resultScore: {
    fontWeight: 900, color: "#ff6200", lineHeight: 1,
    fontFamily: "'Barlow Condensed', sans-serif",
    filter: "drop-shadow(0 0 24px rgba(255,98,0,0.7))",
  },
  resultScoreLabel: {
    fontSize: "clamp(12px,1.8vw,18px)", color: "rgba(255,255,255,0.5)", fontWeight: 600,
    fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 2,
  },

  victoryRays: {
    position: "absolute", inset: -80,
    background: "conic-gradient(from 0deg, transparent 0%, rgba(255,98,0,0.06) 10%, transparent 20%)",
    animation: "arena-victoryray 8s linear infinite",
    pointerEvents: "none",
  },

  // ── Spinner ───────────────────────────────────────────────────────────────────
  spinner: {
    width: "clamp(24px,3.5vw,36px)", height: "clamp(24px,3.5vw,36px)",
    border: "2px solid rgba(255,255,255,0.1)",
    borderTop: "2px solid #ff6200",
    borderRadius: "50%",
    animation: "arena-spin 0.7s linear infinite",
  },

  // ── Loading bar ───────────────────────────────────────────────────────────────
  loadTrack: { position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: "rgba(255,255,255,0.06)" },
  loadFill:  { height: "100%", background: "linear-gradient(90deg, #ff6200, #ff0040)", animation: "arena-loadbar 1.8s ease-in-out infinite" },

  // ── Ghost button (secondary CTA) ──────────────────────────────────────────────
  ghostBtn: {
    padding: "clamp(9px,1.2vw,13px) clamp(16px,2.5vw,28px)",
    background: "transparent",
    color: "rgba(255,255,255,0.55)",
    border: "1.5px solid rgba(255,255,255,0.18)",
    borderRadius: 6,
    fontSize: "clamp(10px,1.4vw,13px)",
    fontWeight: 600,
    letterSpacing: "0.2em",
    cursor: "pointer",
    fontFamily: "'Barlow Condensed', sans-serif",
    transition: "all 0.18s ease",
    textTransform: "uppercase",
    pointerEvents: "all",
  },

  // ── Nickname input ────────────────────────────────────────────────────────────
  nicknameInput: {
    width: "100%",
    padding: "10px 16px",
    background: "rgba(255,255,255,0.05)",
    border: "1.5px solid rgba(255,98,0,0.5)",
    borderRadius: 8,
    color: "#ffffff",
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700,
    fontSize: "clamp(16px,2.5vw,22px)",
    letterSpacing: "0.2em",
    textAlign: "center",
    outline: "none",
    caretColor: "#ff6200",
    boxSizing: "border-box",
    pointerEvents: "all",
  },

  // ── Leaderboard table ─────────────────────────────────────────────────────────
  lbTable: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 3,
    maxHeight: "clamp(200px, 38vh, 340px)",
    overflowY: "auto",
    scrollbarWidth: "none",
  },
  lbRow: {
    display: "grid",
    gridTemplateColumns: "2rem 1fr 3rem 3.5rem",
    alignItems: "center",
    gap: "0 10px",
    padding: "6px 8px",
    transition: "background 0.15s",
  },
  lbHeader: {
    borderBottom: "1px solid rgba(255,98,0,0.25)",
    marginBottom: 2,
    paddingBottom: 6,
  },
  lbRank: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700,
    fontSize: "clamp(12px,1.6vw,16px)",
    color: "rgba(255,255,255,0.35)",
    textAlign: "center",
  },
  lbName: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 400,
    fontSize: "clamp(12px,1.8vw,16px)",
    color: "#ffffff",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    letterSpacing: "0.05em",
  },
  lbScore: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700,
    fontSize: "clamp(14px,2vw,18px)",
    color: "#ffffff",
    textAlign: "right",
    letterSpacing: "0.05em",
  },
  lbDate: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 400,
    fontSize: "clamp(9px,1.2vw,11px)",
    color: "rgba(255,255,255,0.3)",
    textAlign: "right",
    letterSpacing: "0.03em",
  },

  // ── Online 1v1 live HUD strip ─────────────────────────────────────────────────
  onlineHudStrip: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "clamp(4px,0.8vh,10px) clamp(8px,1.5vw,18px)",
    background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)",
    borderBottom: "1px solid rgba(255,98,0,0.2)", gap: 8,
  },
  onlinePlayerChip: { display: "flex", flexDirection: "column", flex: 1 },
  onlineChipName: {
    fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
    fontSize: "clamp(9px,1.3vw,13px)", color: "rgba(255,255,255,0.6)",
    letterSpacing: "0.15em", textTransform: "uppercase",
  },
  onlineChipScore: {
    fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900,
    fontSize: "clamp(20px,3.5vw,36px)", color: "#ffffff", lineHeight: 1,
  },
  onlineVs: {
    fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900,
    fontSize: "clamp(11px,1.6vw,16px)", color: "rgba(255,98,0,0.7)", letterSpacing: 3,
  },
  onlineScoreCompare: {
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: "clamp(12px,3vw,32px)", width: "100%", padding: "8px 0",
  },

  // ── Tab row ───────────────────────────────────────────────────────────────────
  tabRow: { display: "flex", gap: 8, width: "100%" },
  tabBtn: {
    flex: 1, padding: "8px 4px", borderRadius: 6,
    fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
    fontSize: "clamp(10px,1.4vw,13px)", letterSpacing: "0.15em",
    cursor: "pointer", transition: "all 0.15s ease",
    pointerEvents: "all", textTransform: "uppercase",
  },

  // ── Radar / searching animation ───────────────────────────────────────────────
  radarWrap: {
    position: "relative",
    width: "clamp(80px,12vw,110px)",
    height: "clamp(80px,12vw,110px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "4px auto",
  },
  radarCore: {
    position: "relative", zIndex: 3,
    width: "clamp(36px,5vw,50px)", height: "clamp(36px,5vw,50px)",
    borderRadius: "50%",
    background: "rgba(255,98,0,0.15)",
    border: "1.5px solid #ff6200",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "clamp(16px,2.5vw,22px)",
    filter: "drop-shadow(0 0 8px #ff6200)",
  },
  radarRing1: {
    position: "absolute", inset: 0, borderRadius: "50%",
    border: "1.5px solid rgba(255,98,0,0.6)",
    animation: "arena-radar 1.8s ease-out infinite",
    animationDelay: "0s",
  },
  radarRing2: {
    position: "absolute", inset: 0, borderRadius: "50%",
    border: "1.5px solid rgba(255,98,0,0.4)",
    animation: "arena-radar 1.8s ease-out infinite",
    animationDelay: "0.6s",
  },
  radarRing3: {
    position: "absolute", inset: 0, borderRadius: "50%",
    border: "1.5px solid rgba(255,98,0,0.2)",
    animation: "arena-radar 1.8s ease-out infinite",
    animationDelay: "1.2s",
  },

  // ── Video player name labels (online split-screen) ───────────────────────────
  videoLabel: {
    position: "absolute", bottom: 6, left: 6,
    background: "rgba(0,0,0,0.6)",
    borderRadius: 6,
    padding: "2px 8px",
    backdropFilter: "blur(4px)",
    pointerEvents: "none",
    zIndex: 5,
  },
  videoLabelText: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700,
    fontSize: "clamp(9px,1.2vw,13px)",
    color: "rgba(255,255,255,0.85)",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
  },

  // ── Mute button (inside online HUD) ──────────────────────────────────────────
  muteBtn: {
    padding: "3px 8px",
    borderRadius: 6,
    fontSize: "clamp(12px,1.8vw,16px)",
    cursor: "pointer",
    fontFamily: "'Barlow Condensed', sans-serif",
    transition: "all 0.15s ease",
    lineHeight: 1,
  },

  // ── Post-match scoreboard ─────────────────────────────────────────────────────
  postMatchBoard: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    width: "100%",
    padding: "4px 0",
  },
  boardRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "clamp(8px,1.2vh,14px) clamp(10px,1.8vw,18px)",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 10,
    border: "1px solid",
    gap: 8,
  },
  boardName: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700,
    fontSize: "clamp(13px,2vw,18px)",
    color: "#ffffff",
    letterSpacing: "0.08em",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  boardScore: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 900,
    fontSize: "clamp(28px,5vw,48px)",
    lineHeight: 1,
    minWidth: "2.5ch",
    textAlign: "right",
  },
  boardCrown: {
    fontSize: "clamp(16px,2.5vw,22px)",
    lineHeight: 1,
  },
  waitPlayers: {
    display: "flex", gap: "clamp(12px,3vw,28px)",
    width: "100%", justifyContent: "center", padding: "4px 0",
  },
  waitPlayer: {
    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
    padding: "10px 16px", background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10,
    flex: 1, maxWidth: 140, transition: "opacity 0.3s",
  },
  waitPlayerName: {
    fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
    fontSize: "clamp(12px,1.8vw,16px)", color: "#ffffff",
    letterSpacing: "0.1em", textAlign: "center", wordBreak: "break-all",
  },
};
