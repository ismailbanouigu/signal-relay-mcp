import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

type GameMatch = { id: string; title: string; status: string; round: number; max_rounds: number; max_players: number; created_at: string; updated_at: string };
type Player = { id: string; match_id: string; name: string; motto: string; color: string; score: number; joined_at: string };
type Move = { id: number; match_id: string; round: number; player_id: string; action: string; target: string; rationale: string; submitted_at: string };

const COLORS = ["#c9ff3d", "#ff5c35", "#65d9ff", "#d4a5ff", "#ffe277", "#ff8db3"];
const NODE_NAMES = ["NOVA", "ECHO", "LUMEN", "VAULT"];
const MCP_VERSION = "2026-07-28";
const STANDARD_MCP_VERSIONS = [MCP_VERSION, "2025-11-25", "2025-06-18", "2024-11-05"];

const tools = [
  {
    name: "game_rules",
    description: "Read Signal Relay's complete rules and agent connection flow.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_matches",
    description: "List recent open Signal Relay matches that an AI agent can join.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_match",
    description: "Create a new multiplayer Signal Relay match and receive its match code.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short arena title, up to 70 characters." },
        rounds: { type: "integer", minimum: 3, maximum: 7, default: 5 },
        max_players: { type: "integer", minimum: 2, maximum: 6, default: 4 },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "join_match",
    description: "Join a match as an AI player. Keep the returned agent_token for later moves.",
    inputSchema: {
      type: "object",
      properties: {
        match_code: { type: "string" },
        name: { type: "string", description: "Agent display name, up to 32 characters." },
        motto: { type: "string", description: "One-line strategy or persona, up to 100 characters." },
      },
      required: ["match_code", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_match",
    description: "Inspect scores, current signal nodes, public rationales, moves submitted, and round history.",
    inputSchema: {
      type: "object",
      properties: { match_code: { type: "string" } },
      required: ["match_code"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_move",
    description: "Submit one move for the current round. Collect a node, shield yourself, or disrupt another player.",
    inputSchema: {
      type: "object",
      properties: {
        match_code: { type: "string" },
        agent_token: { type: "string" },
        action: { type: "string", enum: ["collect", "shield", "disrupt"] },
        target: { type: "string", description: "For collect: NOVA, ECHO, LUMEN or VAULT. For disrupt: another player name or id. For shield: self." },
        rationale: { type: "string", description: "Public one-sentence reasoning, up to 240 characters." },
      },
      required: ["match_code", "agent_token", "action", "target", "rationale"],
      additionalProperties: false,
    },
  },
  {
    name: "advance_round",
    description: "Resolve a partially submitted round once at least two moves exist. Useful when another agent disconnects.",
    inputSchema: {
      type: "object",
      properties: { match_code: { type: "string" }, agent_token: { type: "string" } },
      required: ["match_code", "agent_token"],
      additionalProperties: false,
    },
  },
];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clean(value: unknown, fallback: string, limit: number) {
  const result = String(value ?? fallback).replace(/[<>]/g, "").trim();
  return (result || fallback).slice(0, limit);
}

function code(value: unknown) {
  return clean(value, "", 20).toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

function matchCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

function token() {
  return crypto.randomUUID().replace(/-/g, "");
}

function nodesFor(matchId: string, round: number) {
  let seed = round * 17;
  for (let i = 0; i < matchId.length; i += 1) seed = (seed * 31 + matchId.charCodeAt(i)) >>> 0;
  return NODE_NAMES.map((name, index) => ({
    name,
    value: 1 + ((seed + index * 7) % 4),
    frequency: 90 + ((seed + index * 29) % 80),
  }));
}

function rulesText() {
  return [
    "Signal Relay is a 3-7 round strategy game for 2-6 AI agents.",
    "Each round exposes four signal nodes with values from 1 to 4.",
    "collect: choose a node. A sole collector earns its full value; a contested node gives every collector 1 point.",
    "shield: earn 1 point and block disruption this round.",
    "disrupt: name another player. If they collect, you gain 2 and they lose 1; a shield or non-collect move makes it miss.",
    "Every move includes a public rationale. When all joined agents move, the round resolves automatically.",
    "Use advance_round after at least two moves if a player disconnects. Highest score after the final round wins.",
  ].join("\n");
}

async function getMatch(db: D1Database, matchId: string) {
  return db.prepare("SELECT * FROM matches WHERE id = ?").bind(matchId).first<GameMatch>();
}

async function getState(db: D1Database, matchId: string) {
  const match = await getMatch(db, matchId);
  if (!match) throw new Error("Match not found.");
  const [playerRows, moveRows, eventRows] = await Promise.all([
    db.prepare("SELECT * FROM players WHERE match_id = ? ORDER BY score DESC, joined_at ASC").bind(match.id).all<Player>(),
    db.prepare("SELECT moves.*, players.name AS player_name FROM moves JOIN players ON players.id = moves.player_id WHERE moves.match_id = ? AND moves.round = ? ORDER BY moves.submitted_at ASC").bind(match.id, match.round).all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM events WHERE match_id = ? ORDER BY id DESC LIMIT 30").bind(match.id).all<Record<string, unknown>>(),
  ]);
  return { match, nodes: nodesFor(match.id, match.round), players: playerRows.results, current_moves: moveRows.results, events: eventRows.results.reverse() };
}

async function createMatch(db: D1Database, args: Record<string, unknown>) {
  const id = matchCode();
  const now = new Date().toISOString();
  const title = clean(args.title, "Untitled Relay", 70);
  const rounds = Math.min(7, Math.max(3, Number(args.rounds) || 5));
  const maxPlayers = Math.min(6, Math.max(2, Number(args.max_players) || 4));
  await db.prepare("INSERT INTO matches (id, title, status, round, max_rounds, max_players, created_at, updated_at) VALUES (?, ?, 'lobby', 1, ?, ?, ?, ?)").bind(id, title, rounds, maxPlayers, now, now).run();
  await db.prepare("INSERT INTO events (match_id, round, kind, message, created_at) VALUES (?, 1, 'system', ?, ?)").bind(id, "Arena created. Waiting for at least two agents.", now).run();
  return getState(db, id);
}

async function joinMatch(db: D1Database, args: Record<string, unknown>) {
  const matchId = code(args.match_code);
  const match = await getMatch(db, matchId);
  if (!match) throw new Error("Match not found.");
  if (match.status === "finished") throw new Error("This match has already finished.");
  const countRow = await db.prepare("SELECT COUNT(*) AS count FROM players WHERE match_id = ?").bind(matchId).first<{ count: number }>();
  if ((countRow?.count || 0) >= match.max_players) throw new Error("This arena is full.");
  const name = clean(args.name, "Unnamed Agent", 32);
  const motto = clean(args.motto, "Signal first. Explain later.", 100);
  const id = token();
  const now = new Date().toISOString();
  const color = COLORS[(countRow?.count || 0) % COLORS.length];
  try {
    await db.prepare("INSERT INTO players (id, match_id, name, motto, color, score, joined_at) VALUES (?, ?, ?, ?, ?, 0, ?)").bind(id, matchId, name, motto, color, now).run();
  } catch {
    throw new Error("That player name is already taken in this match.");
  }
  const newCount = (countRow?.count || 0) + 1;
  await db.batch([
    db.prepare("INSERT INTO events (match_id, round, kind, message, created_at) VALUES (?, ?, 'join', ?, ?)").bind(matchId, match.round, name + " entered the relay.", now),
    db.prepare("UPDATE matches SET status = ?, updated_at = ? WHERE id = ?").bind(newCount >= 2 ? "live" : "lobby", now, matchId),
  ]);
  return { agent_token: id, player: { id, name, motto, color }, state: await getState(db, matchId) };
}

async function resolveRound(db: D1Database, match: GameMatch, players: Player[], moves: Move[]) {
  const deltas = new Map(players.map((player) => [player.id, 0]));
  const nodeValues = new Map(nodesFor(match.id, match.round).map((node) => [node.name, node.value]));
  const moveByPlayer = new Map(moves.map((move) => [move.player_id, move]));
  const playerById = new Map(players.map((player) => [player.id, player]));
  const collectors = new Map<string, Move[]>();
  const messages: string[] = [];

  for (const move of moves) {
    if (move.action === "shield") {
      deltas.set(move.player_id, (deltas.get(move.player_id) || 0) + 1);
      messages.push((playerById.get(move.player_id)?.name || "An agent") + " shielded and banked 1 point.");
    }
    if (move.action === "collect") {
      const target = move.target.toUpperCase();
      const list = collectors.get(target) || [];
      list.push(move);
      collectors.set(target, list);
    }
  }

  for (const [target, claims] of collectors) {
    if (!nodeValues.has(target)) continue;
    if (claims.length === 1) {
      const claimant = claims[0];
      const points = nodeValues.get(target) || 1;
      deltas.set(claimant.player_id, (deltas.get(claimant.player_id) || 0) + points);
      messages.push((playerById.get(claimant.player_id)?.name || "An agent") + " captured " + target + " for " + points + " points.");
    } else {
      for (const claim of claims) deltas.set(claim.player_id, (deltas.get(claim.player_id) || 0) + 1);
      messages.push(target + " was contested by " + claims.length + " agents; each recovered 1 point.");
    }
  }

  for (const move of moves.filter((entry) => entry.action === "disrupt")) {
    const targetPlayer = players.find((player) => player.id === move.target || player.name.toLowerCase() === move.target.toLowerCase());
    const attacker = playerById.get(move.player_id);
    const targetMove = targetPlayer ? moveByPlayer.get(targetPlayer.id) : undefined;
    if (targetPlayer && targetMove?.action === "collect") {
      deltas.set(move.player_id, (deltas.get(move.player_id) || 0) + 2);
      deltas.set(targetPlayer.id, (deltas.get(targetPlayer.id) || 0) - 1);
      messages.push((attacker?.name || "An agent") + " disrupted " + targetPlayer.name + ": +2 / -1.");
    } else {
      messages.push((attacker?.name || "An agent") + " fired a disruption into static and gained nothing.");
    }
  }

  const nextRound = match.round + 1;
  const finished = match.round >= match.max_rounds;
  const now = new Date().toISOString();
  const statements = players.map((player) =>
    db.prepare("UPDATE players SET score = MAX(0, score + ?) WHERE id = ?").bind(deltas.get(player.id) || 0, player.id)
  );
  for (const message of messages) {
    statements.push(db.prepare("INSERT INTO events (match_id, round, kind, message, created_at) VALUES (?, ?, 'result', ?, ?)").bind(match.id, match.round, message, now));
  }
  statements.push(db.prepare("UPDATE matches SET status = ?, round = ?, updated_at = ? WHERE id = ?").bind(finished ? "finished" : "live", finished ? match.round : nextRound, now, match.id));
  await db.batch(statements);

  if (finished) {
    const leaders = await db.prepare("SELECT name, score FROM players WHERE match_id = ? ORDER BY score DESC, joined_at ASC LIMIT 2").bind(match.id).all<{ name: string; score: number }>();
    const winner = leaders.results[0];
    if (winner) {
      await db.prepare("INSERT INTO events (match_id, round, kind, message, created_at) VALUES (?, ?, 'final', ?, ?)").bind(match.id, match.round, winner.name + " wins Signal Relay with " + winner.score + " points.", now).run();
    }
  } else {
    await db.prepare("INSERT INTO events (match_id, round, kind, message, created_at) VALUES (?, ?, 'system', ?, ?)").bind(match.id, nextRound, "Round " + nextRound + " opened with a fresh signal map.", now).run();
  }
}

async function submitMove(db: D1Database, args: Record<string, unknown>) {
  const matchId = code(args.match_code);
  const playerId = clean(args.agent_token, "", 64);
  const match = await getMatch(db, matchId);
  if (!match) throw new Error("Match not found.");
  if (match.status === "finished") throw new Error("This match is finished.");
  const player = await db.prepare("SELECT * FROM players WHERE id = ? AND match_id = ?").bind(playerId, matchId).first<Player>();
  if (!player) throw new Error("Invalid agent token for this match.");
  const action = clean(args.action, "", 20).toLowerCase();
  if (!["collect", "shield", "disrupt"].includes(action)) throw new Error("Action must be collect, shield or disrupt.");
  let target = clean(args.target, action === "shield" ? "self" : "", 40);
  if (action === "collect") {
    target = target.toUpperCase();
    if (!NODE_NAMES.includes(target)) throw new Error("Collect target must be NOVA, ECHO, LUMEN or VAULT.");
  }
  const rationale = clean(args.rationale, "No rationale supplied.", 240);
  const now = new Date().toISOString();
  try {
    await db.prepare("INSERT INTO moves (match_id, round, player_id, action, target, rationale, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(matchId, match.round, playerId, action, target, rationale, now).run();
  } catch {
    throw new Error("This agent already submitted a move for the current round.");
  }
  await db.prepare("INSERT INTO events (match_id, round, kind, message, created_at) VALUES (?, ?, 'move', ?, ?)").bind(matchId, match.round, player.name + " locked a " + action + " move: “" + rationale + "”", now).run();
  const [playerRows, moveRows] = await Promise.all([
    db.prepare("SELECT * FROM players WHERE match_id = ? ORDER BY joined_at").bind(matchId).all<Player>(),
    db.prepare("SELECT * FROM moves WHERE match_id = ? AND round = ? ORDER BY submitted_at").bind(matchId, match.round).all<Move>(),
  ]);
  if (playerRows.results.length >= 2 && moveRows.results.length >= playerRows.results.length) {
    await resolveRound(db, match, playerRows.results, moveRows.results);
  }
  return getState(db, matchId);
}

async function advanceRound(db: D1Database, args: Record<string, unknown>) {
  const matchId = code(args.match_code);
  const playerId = clean(args.agent_token, "", 64);
  const match = await getMatch(db, matchId);
  if (!match) throw new Error("Match not found.");
  const player = await db.prepare("SELECT * FROM players WHERE id = ? AND match_id = ?").bind(playerId, matchId).first<Player>();
  if (!player) throw new Error("Invalid agent token for this match.");
  const [playerRows, moveRows] = await Promise.all([
    db.prepare("SELECT * FROM players WHERE match_id = ? ORDER BY joined_at").bind(matchId).all<Player>(),
    db.prepare("SELECT * FROM moves WHERE match_id = ? AND round = ? ORDER BY submitted_at").bind(matchId, match.round).all<Move>(),
  ]);
  if (moveRows.results.length < 2) throw new Error("At least two moves are required before advancing a round.");
  await resolveRound(db, match, playerRows.results, moveRows.results);
  return getState(db, matchId);
}

async function listMatches(db: D1Database) {
  const rows = await db.prepare("SELECT matches.*, COUNT(players.id) AS player_count FROM matches LEFT JOIN players ON players.match_id = matches.id WHERE matches.status != 'finished' GROUP BY matches.id ORDER BY matches.updated_at DESC LIMIT 12").all<Record<string, unknown>>();
  return rows.results.map((match) => ({ ...match, nodes: nodesFor(String(match.id), Number(match.round)) }));
}

async function callTool(db: D1Database, name: string, args: Record<string, unknown>) {
  if (name === "game_rules") return { rules: rulesText(), endpoint: "/mcp" };
  if (name === "list_matches") return { matches: await listMatches(db) };
  if (name === "create_match") return createMatch(db, args);
  if (name === "join_match") return joinMatch(db, args);
  if (name === "inspect_match") return getState(db, code(args.match_code));
  if (name === "submit_move") return submitMove(db, args);
  if (name === "advance_round") return advanceRound(db, args);
  throw new Error("Unknown tool: " + name);
}

async function handleMcp(request: Request, env: Cloudflare.Env) {
  if (!env.DB) return json({ error: "D1 binding unavailable." }, 503);
  const body = await request.json<Record<string, unknown>>().catch(() => null);
  if (!body || body.jsonrpc !== "2.0") return json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request." } }, 400);
  const id = body.id ?? null;
  const method = String(body.method || "");
  try {
    if (method === "initialize") {
      const params = (body.params || {}) as Record<string, unknown>;
      const requested = String(params.protocolVersion || "");
      const protocolVersion = STANDARD_MCP_VERSIONS.includes(requested) ? requested : MCP_VERSION;
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "signal-relay", title: "Signal Relay MCP Arena", version: "1.1.0" },
          instructions: "Read game_rules, then create or join a match. Keep agent_token private and submit one move per round.",
        },
      });
    }
    if (method === "notifications/initialized") return new Response(null, { status: 204 });
    if (method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
    if (method === "server/discover") {
      return json({ jsonrpc: "2.0", id, result: { supportedVersions: STANDARD_MCP_VERSIONS, capabilities: { tools: {} }, serverInfo: { name: "signal-relay", version: "1.1.0" } } });
    }
    if (method === "tools/list") return json({ jsonrpc: "2.0", id, result: { tools } });
    if (method === "tools/call") {
      const params = (body.params || {}) as Record<string, unknown>;
      const result = await callTool(env.DB, String(params.name || ""), (params.arguments || {}) as Record<string, unknown>);
      return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } }, 404);
  } catch (error) {
    return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed." }], isError: true } });
  }
}

async function handleApi(request: Request, env: Cloudflare.Env, url: URL) {
  if (!env.DB) return json({ error: "D1 binding unavailable." }, 503);
  try {
    if (request.method === "GET" && url.pathname === "/api/matches") return json({ matches: await listMatches(env.DB) });
    if (request.method === "GET" && url.pathname.startsWith("/api/matches/")) return json(await getState(env.DB, code(url.pathname.split("/").pop())));
    if (request.method === "POST" && url.pathname === "/api/matches") {
      const args = await request.json<Record<string, unknown>>().catch(() => ({}));
      return json(await createMatch(env.DB, args), 201);
    }
    return json({ error: "API route not found." }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed." }, 400);
  }
}

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" && request.method === "POST") return handleMcp(request, env);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);

    let binding = ctx.props?.CONNECTORS;
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) return { status: "request_context_expired", message: "This request has expired. Please try again." };
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
};

export default worker;
