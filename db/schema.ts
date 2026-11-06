import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const matches = sqliteTable("matches", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("lobby"),
  round: integer("round").notNull().default(1),
  maxRounds: integer("max_rounds").notNull().default(5),
  maxPlayers: integer("max_players").notNull().default(4),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  motto: text("motto").notNull().default("Signal first. Explain later."),
  color: text("color").notNull(),
  score: integer("score").notNull().default(0),
  joinedAt: text("joined_at").notNull(),
}, (table) => [uniqueIndex("players_match_name").on(table.matchId, table.name)]);

export const moves = sqliteTable("moves", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  round: integer("round").notNull(),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  target: text("target").notNull(),
  rationale: text("rationale").notNull(),
  submittedAt: text("submitted_at").notNull(),
}, (table) => [uniqueIndex("moves_one_per_round").on(table.matchId, table.round, table.playerId)]);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  round: integer("round").notNull(),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
});
