import { DurableObject } from "cloudflare:workers";

type GameMatch = {
  id: string;
  title: string;
  status: "lobby" | "live" | "finished";
  round: number;
  max_rounds: number;
  max_players: number;
  created_at: string;
  updated_at: string;
};

type Player = {
  id: string;
  token: string;
  match_id: string;
  name: string;
  motto: string;
  color: string;
  score: number;
  joined_at: string;
};

type Move = {
  id: number;
  match_id: string;
  round: number;
  player_id: string;
  action: "collect" | "shield" | "disrupt";
  target: string;
  rationale: string;
  submitted_at: string;
};

type GameEvent = {
  id: number;
  match_id: string;
  round: number;
  kind: string;
  message: string;
  created_at: string;
};

type GameData = {
  matches: Record<string, GameMatch>;
  players: Player[];
  moves: Move[];
  events: GameEvent[];
  nextMoveId: number;
  nextEventId: number;
};

type Env = { GAME: DurableObjectNamespace<GameHub> };

const COLORS = ["#c9ff3d", "#ff5c35", "#65d9ff", "#d4a5ff", "#ffe277", "#ff8db3"];
const NODE_NAMES = ["NOVA", "ECHO", "LUMEN", "VAULT"];
const MCP_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2024-11-05"];
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-protocol-version",
};

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

function clean(value: unknown, fallback: string, limit: number) {
  const result = String(value ?? fallback).replace(/[<>]/g, "").trim();
  return (result || fallback).slice(0, limit);
}

function matchCode(value?: unknown) {
  if (value !== undefined) return clean(value, "", 20).toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

function token() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function nodesFor(matchId: string, round: number) {
  let seed = round * 17;
  for (let index = 0; index < matchId.length; index += 1) seed = (seed * 31 + matchId.charCodeAt(index)) >>> 0;
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

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function emptyData(): GameData {
  return { matches: {}, players: [], moves: [], events: [], nextMoveId: 1, nextEventId: 1 };
}

export class GameHub extends DurableObject<Env> {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
  }

  private async load() {
    return (await this.state.storage.get<GameData>("game")) ?? emptyData();
  }

  private async save(data: GameData) {
    await this.state.storage.put("game", data);
  }

  private addEvent(data: GameData, matchId: string, round: number, kind: string, message: string, createdAt = new Date().toISOString()) {
    data.events.push({ id: data.nextEventId++, match_id: matchId, round, kind, message, created_at: createdAt });
  }

  private getMatch(data: GameData, matchId: string) {
    const match = data.matches[matchId];
    if (!match) throw new Error("Match not found.");
    return match;
  }

  private getState(data: GameData, matchId: string) {
    const match = this.getMatch(data, matchId);
    const players = data.players
      .filter((player) => player.match_id === matchId)
      .sort((left, right) => right.score - left.score || left.joined_at.localeCompare(right.joined_at))
      .map(({ token: _token, ...player }) => player);
    const names = new Map(players.map((player) => [player.id, player.name]));
    const currentMoves = data.moves
      .filter((move) => move.match_id === matchId && move.round === match.round)
      .sort((left, right) => left.submitted_at.localeCompare(right.submitted_at))
      .map((move) => ({ ...move, player_name: names.get(move.player_id) || "Agent" }));
    const events = data.events.filter((event) => event.match_id === matchId).slice(-30);
    return { match, nodes: nodesFor(match.id, match.round), players, current_moves: currentMoves, events };
  }

  private prune(data: GameData) {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const stale = new Set(
      Object.values(data.matches)
        .filter((match) => match.status === "finished" && Date.parse(match.updated_at) < cutoff)
        .map((match) => match.id),
    );
    for (const id of stale) delete data.matches[id];
    if (stale.size) {
      data.players = data.players.filter((player) => !stale.has(player.match_id));
      data.moves = data.moves.filter((move) => !stale.has(move.match_id));
      data.events = data.events.filter((event) => !stale.has(event.match_id));
    }
  }

  private async createMatch(data: GameData, args: Record<string, unknown>) {
    this.prune(data);
    let id = matchCode();
    while (data.matches[id]) id = matchCode();
    const now = new Date().toISOString();
    const match: GameMatch = {
      id,
      title: clean(args.title, "Untitled Relay", 70),
      status: "lobby",
      round: 1,
      max_rounds: Math.min(7, Math.max(3, Number(args.rounds) || 5)),
      max_players: Math.min(6, Math.max(2, Number(args.max_players) || 4)),
      created_at: now,
      updated_at: now,
    };
    data.matches[id] = match;
    this.addEvent(data, id, 1, "system", "Arena created. Waiting for at least two agents.", now);
    await this.save(data);
    return this.getState(data, id);
  }

  private async joinMatch(data: GameData, args: Record<string, unknown>) {
    const matchId = matchCode(args.match_code);
    const match = this.getMatch(data, matchId);
    if (match.status === "finished") throw new Error("This match has already finished.");
    const players = data.players.filter((player) => player.match_id === matchId);
    if (players.length >= match.max_players) throw new Error("This arena is full.");
    const name = clean(args.name, "Unnamed Agent", 32);
    if (players.some((player) => player.name.toLowerCase() === name.toLowerCase())) throw new Error("That player name is already taken in this match.");
    const now = new Date().toISOString();
    const player: Player = {
      id: crypto.randomUUID(),
      token: token(),
      match_id: matchId,
      name,
      motto: clean(args.motto, "Signal first. Explain later.", 100),
      color: COLORS[players.length % COLORS.length],
      score: 0,
      joined_at: now,
    };
    data.players.push(player);
    match.status = players.length + 1 >= 2 ? "live" : "lobby";
    match.updated_at = now;
    this.addEvent(data, matchId, match.round, "join", name + " entered the relay.", now);
    await this.save(data);
    const { token: _token, ...publicPlayer } = player;
    return { agent_token: player.token, player: publicPlayer, state: this.getState(data, matchId) };
  }

  private resolveRound(data: GameData, match: GameMatch, players: Player[], moves: Move[]) {
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
      } else if (move.action === "collect") {
        const target = move.target.toUpperCase();
        collectors.set(target, [...(collectors.get(target) || []), move]);
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
      const target = players.find((player) => player.id === move.target || player.name.toLowerCase() === move.target.toLowerCase());
      const attacker = playerById.get(move.player_id);
      const targetMove = target ? moveByPlayer.get(target.id) : undefined;
      if (target && targetMove?.action === "collect") {
        deltas.set(move.player_id, (deltas.get(move.player_id) || 0) + 2);
        deltas.set(target.id, (deltas.get(target.id) || 0) - 1);
        messages.push((attacker?.name || "An agent") + " disrupted " + target.name + ": +2 / -1.");
      } else {
        messages.push((attacker?.name || "An agent") + " fired a disruption into static and gained nothing.");
      }
    }

    for (const player of players) player.score = Math.max(0, player.score + (deltas.get(player.id) || 0));
    const now = new Date().toISOString();
    for (const message of messages) this.addEvent(data, match.id, match.round, "result", message, now);
    if (match.round >= match.max_rounds) {
      match.status = "finished";
      const winner = [...players].sort((left, right) => right.score - left.score || left.joined_at.localeCompare(right.joined_at))[0];
      if (winner) this.addEvent(data, match.id, match.round, "final", winner.name + " wins Signal Relay with " + winner.score + " points.", now);
    } else {
      match.round += 1;
      match.status = "live";
      this.addEvent(data, match.id, match.round, "system", "Round " + match.round + " opened with a fresh signal map.", now);
    }
    match.updated_at = now;
  }

  private async submitMove(data: GameData, args: Record<string, unknown>) {
    const matchId = matchCode(args.match_code);
    const match = this.getMatch(data, matchId);
    if (match.status === "finished") throw new Error("This match is finished.");
    const playerToken = clean(args.agent_token, "", 128);
    const player = data.players.find((entry) => entry.match_id === matchId && entry.token === playerToken);
    if (!player) throw new Error("Invalid agent token for this match.");
    const action = clean(args.action, "", 20).toLowerCase() as Move["action"];
    if (!["collect", "shield", "disrupt"].includes(action)) throw new Error("Action must be collect, shield or disrupt.");
    let target = clean(args.target, action === "shield" ? "self" : "", 40);
    if (action === "collect") {
      target = target.toUpperCase();
      if (!NODE_NAMES.includes(target)) throw new Error("Collect target must be NOVA, ECHO, LUMEN or VAULT.");
    }
    if (data.moves.some((move) => move.match_id === matchId && move.round === match.round && move.player_id === player.id)) {
      throw new Error("This agent already submitted a move for the current round.");
    }
    const now = new Date().toISOString();
    const move: Move = {
      id: data.nextMoveId++,
      match_id: matchId,
      round: match.round,
      player_id: player.id,
      action,
      target,
      rationale: clean(args.rationale, "No rationale supplied.", 240),
      submitted_at: now,
    };
    data.moves.push(move);
    this.addEvent(data, matchId, match.round, "move", player.name + " locked a " + action + " move: “" + move.rationale + "”", now);
    const players = data.players.filter((entry) => entry.match_id === matchId);
    const moves = data.moves.filter((entry) => entry.match_id === matchId && entry.round === match.round);
    if (players.length >= 2 && moves.length >= players.length) this.resolveRound(data, match, players, moves);
    await this.save(data);
    return this.getState(data, matchId);
  }

  private async advanceRound(data: GameData, args: Record<string, unknown>) {
    const matchId = matchCode(args.match_code);
    const match = this.getMatch(data, matchId);
    if (match.status === "finished") throw new Error("This match is finished.");
    const playerToken = clean(args.agent_token, "", 128);
    const player = data.players.find((entry) => entry.match_id === matchId && entry.token === playerToken);
    if (!player) throw new Error("Invalid agent token for this match.");
    const players = data.players.filter((entry) => entry.match_id === matchId);
    const moves = data.moves.filter((entry) => entry.match_id === matchId && entry.round === match.round);
    if (moves.length < 2) throw new Error("At least two moves are required before advancing a round.");
    this.resolveRound(data, match, players, moves);
    await this.save(data);
    return this.getState(data, matchId);
  }

  private listMatches(data: GameData) {
    return Object.values(data.matches)
      .filter((match) => match.status !== "finished")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, 12)
      .map((match) => ({
        ...match,
        player_count: data.players.filter((player) => player.match_id === match.id).length,
        nodes: nodesFor(match.id, match.round),
      }));
  }

  private async callTool(data: GameData, name: string, args: Record<string, unknown>) {
    if (name === "game_rules") return { rules: rulesText(), endpoint: "/mcp" };
    if (name === "list_matches") return { matches: this.listMatches(data) };
    if (name === "create_match") return this.createMatch(data, args);
    if (name === "join_match") return this.joinMatch(data, args);
    if (name === "inspect_match") return this.getState(data, matchCode(args.match_code));
    if (name === "submit_move") return this.submitMove(data, args);
    if (name === "advance_round") return this.advanceRound(data, args);
    throw new Error("Unknown tool: " + name);
  }

  private async handleMcp(request: Request) {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request." } }, 400);
    }
    const id = body.id ?? null;
    const method = body.method;
    const params = (body.params || {}) as Record<string, unknown>;

    if (method === "notifications/initialized") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (method === "initialize") {
      const requested = String(params.protocolVersion || "");
      const protocolVersion = MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0];
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "signal-relay", title: "Signal Relay MCP Arena", version: "1.1.0" },
          instructions: "Read game_rules, then create or join a match. Keep agent_token private and submit one move per round.",
        },
      }, 200, { "mcp-protocol-version": protocolVersion });
    }
    if (method === "server/discover") {
      return json({ jsonrpc: "2.0", id, result: { supportedVersions: MCP_VERSIONS, capabilities: { tools: {} }, serverInfo: { name: "signal-relay", version: "1.1.0" } } });
    }
    if (method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return json({ jsonrpc: "2.0", id, result: { tools } });
    if (method === "tools/call") {
      try {
        const data = await this.load();
        const result = await this.callTool(data, String(params.name || ""), (params.arguments || {}) as Record<string, unknown>);
        return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      } catch (error) {
        return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed." }], isError: true } });
      }
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "signal-relay", mcp: "/mcp", storage: "durable-object" });
    }
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return json({ error: "Use POST for MCP requests." }, 405, { allow: "POST" });
      return this.handleMcp(request);
    }
    const data = await this.load();
    try {
      if (request.method === "GET" && url.pathname === "/api/matches") return json({ matches: this.listMatches(data) });
      if (request.method === "GET" && url.pathname.startsWith("/api/matches/")) {
        return json(this.getState(data, matchCode(url.pathname.split("/").pop())));
      }
      if (request.method === "POST" && url.pathname === "/api/matches") {
        const args = await request.json<Record<string, unknown>>().catch(() => ({}));
        return json(await this.createMatch(data, args), 201);
      }
      return json({ error: "Route not found." }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Request failed." }, 400);
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const id = env.GAME.idFromName("signal-relay-global");
    return env.GAME.get(id).fetch(request);
  },
};
