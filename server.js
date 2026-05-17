/**
 * 67Arena — Matchmaking Server
 * ────────────────────────────
 * Node.js + Express + Socket.IO
 * Port: 4000
 * CORS: http://localhost:3000
 *
 * CLIENT ──────────────────────────────────── SERVER
 *  join_queue      { nickname }        →  enter waiting pool
 *  leave_queue     {}                  →  cancel matchmaking
 *  rep_scored      { score, combo }    →  relay to opponent
 *  client_ready    {}                  →  ack (reserved for future use)
 *  rematch_vote    {}                  →  vote for rematch
 *  find_another    {}                  →  leave match, rejoin queue
 *  exit_match      {}                  →  leave match, return to menu
 *  voice_offer     { sdp }             →  WebRTC relay to opponent
 *  voice_answer    { sdp }             →  WebRTC relay to opponent
 *  voice_ice       { candidate }       →  WebRTC relay to opponent
 *
 * SERVER ──────────────────────────────────── CLIENT
 *  match_found     { opponentNickname, isInitiator }
 *  countdown_tick  { count }           →  3, 2, 1
 *  match_start     {}
 *  opponent_rep    { score, combo }    →  live score update
 *  match_end       { winner, scores: { local, opponent } }
 *  opponent_left   {}                  →  opponent disconnected
 *  opponent_rematch_vote {}            →  opponent wants rematch
 *  rematch_starting {}                 →  both voted, restarting
 *  opponent_declined_rematch {}        →  opponent chose find_another or exit
 *  voice_offer/answer/ice             →  relay (unchanged) to opponent
 */

"use strict";

const express   = require("express");
const http      = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT          = process.env.PORT || 4000;
const MATCH_DURATION = 10_000; // ms  (must match GAME_DURATION on frontend)
const CORS_ORIGIN   = process.env.CORS_ORIGIN || "http://localhost:3000";

// ─── App setup ────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ─── In-memory state ─────────────────────────────────────────────────────────

/**
 * waitingQueue: Socket[]
 *   Sockets currently searching for an opponent.
 *
 * matches: Map<matchId, Match>
 *   Match = {
 *     id:           string,
 *     players:      [Socket, Socket],   // [p0, p1]
 *     scores:       [number, number],   // live scores
 *     timer:        NodeJS.Timeout | null,
 *     rematchVotes: Set<socketId>,
 *     phase:        "playing" | "ended"
 *   }
 *
 * socketToMatch: Map<socketId, matchId>
 *   Fast reverse-lookup: which match is this socket in?
 */
const waitingQueue   = [];
const matches        = new Map();
const socketToMatch  = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return the other socket in a match (or null). */
function getOpponent(match, socket) {
  return match.players.find(p => p.id !== socket.id) ?? null;
}

/** Return the score index (0 or 1) for a socket inside a match. */
function playerIndex(match, socket) {
  return match.players[0].id === socket.id ? 0 : 1;
}

/** Clean up a match from all maps and clear its timer. */
function destroyMatch(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  clearTimeout(match.timer);
  match.players.forEach(p => socketToMatch.delete(p.id));
  matches.delete(matchId);
}

/** Remove a socket from the waiting queue (no-op if not present). */
function removeFromQueue(socket) {
  const idx = waitingQueue.indexOf(socket);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

/**
 * Emit match_found to both players, then run the synced countdown,
 * then emit match_start and start the server-side match timer.
 */
function startMatch(p0, p1) {
  const matchId = uuidv4();
  const match = {
    id:           matchId,
    players:      [p0, p1],
    scores:       [0, 0],
    timer:        null,
    rematchVotes: new Set(),
    phase:        "playing",
  };
  matches.set(matchId, match);
  socketToMatch.set(p0.id, matchId);
  socketToMatch.set(p1.id, matchId);

  // Tell each player who they're facing and who initiates WebRTC (p0 = initiator)
  p0.emit("match_found", { opponentNickname: p1.nickname, isInitiator: true });
  p1.emit("match_found", { opponentNickname: p0.nickname, isInitiator: false });

  console.log(`[match] ${matchId}: "${p0.nickname}" vs "${p1.nickname}"`);

  // Synced countdown: 3 → 2 → 1 → match_start
  let count = 3;
  const tick = () => {
    if (count <= 0) {
      // Fire match_start to both
      io.to(matchId).emit("match_start");
      console.log(`[match] ${matchId}: started`);

      // Server-authoritative timer — ends the match after MATCH_DURATION ms
      match.timer = setTimeout(() => endMatch(matchId), MATCH_DURATION);
      return;
    }
    io.to(matchId).emit("countdown_tick", { count });
    count--;
    setTimeout(tick, 1000);
  };

  // Join both sockets to the match room so we can broadcast to matchId
  p0.join(matchId);
  p1.join(matchId);

  // Small delay before first tick so the "Match found!" screen has a moment to render
  setTimeout(tick, 800);
}

/**
 * End the match: determine winner, emit match_end to both players.
 */
function endMatch(matchId) {
  const match = matches.get(matchId);
  if (!match || match.phase === "ended") return;
  match.phase = "ended";
  clearTimeout(match.timer);

  const [s0, s1] = match.scores;
  const winner   = s0 > s1 ? 0 : s1 > s0 ? 1 : -1; // -1 = draw

  const [p0, p1] = match.players;

  // Emit from each player's perspective (local = you, opponent = them)
  p0.emit("match_end", {
    winner: winner === 0 ? "local" : winner === 1 ? "opponent" : "draw",
    scores: { local: s0, opponent: s1 },
  });
  p1.emit("match_end", {
    winner: winner === 1 ? "local" : winner === 0 ? "opponent" : "draw",
    scores: { local: s1, opponent: s0 },
  });

  console.log(`[match] ${matchId}: ended — "${p0.nickname}"=${s0} vs "${p1.nickname}"=${s1}`);
  // Don't destroy yet — keep match state alive for rematch voting
}

/**
 * Restart a match (rematch). Reset scores, re-run countdown.
 */
function rematchMatch(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  match.scores      = [0, 0];
  match.rematchVotes.clear();
  match.phase       = "playing";
  clearTimeout(match.timer);

  const [p0, p1] = match.players;
  io.to(matchId).emit("rematch_starting");
  console.log(`[match] ${matchId}: rematch`);

  // Re-run countdown
  let count = 3;
  const tick = () => {
    if (count <= 0) {
      io.to(matchId).emit("match_start");
      match.timer = setTimeout(() => endMatch(matchId), MATCH_DURATION);
      return;
    }
    io.to(matchId).emit("countdown_tick", { count });
    count--;
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 600);
}

// ─── Socket.IO connection handler ────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);
  socket.nickname = "Fighter"; // default until join_queue

  // ── join_queue ─────────────────────────────────────────────────────────────
  socket.on("join_queue", ({ nickname } = {}) => {
    socket.nickname = (nickname || "Fighter").trim().slice(0, 16);
    removeFromQueue(socket); // safety: avoid duplicates

    // If there's already someone waiting, pair immediately
    if (waitingQueue.length > 0) {
      const opponent = waitingQueue.shift();
      startMatch(opponent, socket);
    } else {
      waitingQueue.push(socket);
      console.log(`[queue] "${socket.nickname}" waiting (queue length: ${waitingQueue.length})`);
    }
  });

  // ── leave_queue ────────────────────────────────────────────────────────────
  socket.on("leave_queue", () => {
    removeFromQueue(socket);
    console.log(`[queue] "${socket.nickname}" left queue`);
  });

  // ── rep_scored / score_update ──────────────────────────────────────────────
  // Both names accepted — frontend uses rep_scored, score_update is an alias
  function handleRepScored(socket, { score, combo } = {}) {
    const matchId = socketToMatch.get(socket.id);
    if (!matchId) return;
    const match = matches.get(matchId);
    if (!match || match.phase !== "playing") return;

    const idx = playerIndex(match, socket);
    match.scores[idx] = typeof score === "number" ? score : match.scores[idx] + 1;
    console.log(`[score] ${socket.nickname}=${match.scores[idx]}`);

    const opponent = getOpponent(match, socket);
    opponent?.emit("opponent_rep", { score: match.scores[idx], combo });
  }

  socket.on("rep_scored",   (data) => handleRepScored(socket, data));
  socket.on("score_update", (data) => handleRepScored(socket, data));

  // ── client_ready ───────────────────────────────────────────────────────────
  // Reserved — ack from client that it received countdown. No action needed yet.
  socket.on("client_ready", () => {});

  // ── rematch_vote ───────────────────────────────────────────────────────────
  socket.on("rematch_vote", () => {
    const matchId = socketToMatch.get(socket.id);
    if (!matchId) return;
    const match = matches.get(matchId);
    if (!match || match.phase !== "ended") return;

    match.rematchVotes.add(socket.id);

    const opponent = getOpponent(match, socket);
    // Tell opponent this player voted
    opponent?.emit("opponent_rematch_vote");

    // Both voted → restart
    if (match.rematchVotes.size >= 2) {
      rematchMatch(matchId);
    }
  });

  // ── find_another ───────────────────────────────────────────────────────────
  socket.on("find_another", () => {
    const matchId = socketToMatch.get(socket.id);
    if (matchId) {
      const match   = matches.get(matchId);
      const opponent = match ? getOpponent(match, socket) : null;

      // Tell opponent this player left the match
      opponent?.emit("opponent_declined_rematch");
      socket.leave(matchId);

      // If the match is ended (post-game), destroy it; otherwise the opponent
      // stays in a valid "opponent left" state
      if (match?.phase === "ended") {
        destroyMatch(matchId);
      } else {
        // Mid-match disconnect — remove this socket only
        socketToMatch.delete(socket.id);
      }
    }

    // Re-enter matchmaking queue
    removeFromQueue(socket);
    if (waitingQueue.length > 0) {
      const nextOpponent = waitingQueue.shift();
      startMatch(nextOpponent, socket);
    } else {
      waitingQueue.push(socket);
      console.log(`[queue] "${socket.nickname}" re-queued`);
    }
  });

  // ── exit_match ─────────────────────────────────────────────────────────────
  socket.on("exit_match", () => {
    const matchId = socketToMatch.get(socket.id);
    if (matchId) {
      const match    = matches.get(matchId);
      const opponent = match ? getOpponent(match, socket) : null;
      opponent?.emit("opponent_declined_rematch");
      socket.leave(matchId);
      destroyMatch(matchId);
    }
    removeFromQueue(socket);
    console.log(`[exit] "${socket.nickname}" returned to menu`);
  });

  // ── WebRTC signalling — relay to opponent in same match ───────────────────
  // Server does NOT inspect SDP/ICE — just forwards to the other socket.
  // CRITICAL: relay must happen AFTER socketToMatch is set (it is, in startMatch).
  function relayToOpponent(socket, event, payload) {
    const matchId  = socketToMatch.get(socket.id);
    const match    = matchId ? matches.get(matchId) : null;
    const opponent = match ? getOpponent(match, socket) : null;
    if (opponent) {
      opponent.emit(event, payload);
      console.log(`[relay] ${event} from ${socket.id.slice(0,6)} to ${opponent.id.slice(0,6)}`);
    } else {
      console.warn(`[relay] ${event} — no opponent found for ${socket.id.slice(0,6)} (matchId: ${matchId})`);
    }
  }

  socket.on("webrtc_offer",         (payload) => relayToOpponent(socket, "webrtc_offer",         payload));
  socket.on("webrtc_answer",        (payload) => relayToOpponent(socket, "webrtc_answer",        payload));
  socket.on("webrtc_ice_candidate", (payload) => relayToOpponent(socket, "webrtc_ice_candidate", payload));
  // Legacy names — map to standardised events
  socket.on("voice_offer",  (payload) => relayToOpponent(socket, "webrtc_offer",         payload));
  socket.on("voice_answer", (payload) => relayToOpponent(socket, "webrtc_answer",        payload));
  socket.on("voice_ice",    (payload) => relayToOpponent(socket, "webrtc_ice_candidate", payload));

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    console.log(`[disconnect] "${socket.nickname}" (${socket.id}): ${reason}`);

    // Remove from queue if waiting
    removeFromQueue(socket);

    // Notify opponent if in a match
    const matchId = socketToMatch.get(socket.id);
    if (matchId) {
      const match    = matches.get(matchId);
      const opponent = match ? getOpponent(match, socket) : null;

      if (opponent) {
        opponent.emit("opponent_left");
        // If match was still playing, end it — opponent wins by default
        if (match.phase === "playing") {
          clearTimeout(match.timer);
          match.phase = "ended";
          const opponentIdx = playerIndex(match, opponent);
          const myIdx       = playerIndex(match, socket);
          opponent.emit("match_end", {
            winner: "local",
            scores: {
              local:    match.scores[opponentIdx],
              opponent: match.scores[myIdx],
            },
          });
        }
      }
      destroyMatch(matchId);
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🏟️  67Arena server running on http://localhost:${PORT}`);
  console.log(`   CORS origin: ${CORS_ORIGIN}`);
  console.log(`   Match duration: ${MATCH_DURATION / 1000}s\n`);
});
