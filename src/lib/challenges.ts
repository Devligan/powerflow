import { randomInt } from "node:crypto";
import { createDeskAccount, getOwnedDesk, type Desk } from "@/lib/desk";
import { buildWindow, challengeWindow, nextMove, type ChallengeWindow, type ChallengeMove } from "@/lib/challenge-schedule";
import { catchUpAccount, getSimClock, setSimClock, type SimClock } from "@/lib/sim-clock";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Challenges (0049): the same past operating days, traded by friends on fresh
 * desks, ranked by P&L. The engine enforces the rules (forward-only clock,
 * the challenge's own days, closed once finished); this module creates,
 * enters, moves and finishes, always for the signed-in trader's own entry.
 */

export interface Challenge {
  id: string;
  slug: string;
  title: string;
  firstDay: string;
  lastDay: string;
  startsAt: string;
  finishesAt: string;
  createdAt: string;
}

export interface StandingRow {
  rank: number | null;
  displayName: string;
  avatarUrl: string | null;
  isViewer: boolean;
  status: "ACTIVE" | "FINISHED";
  pnl: string | null;
  finishedAt: string | null;
}

interface ChallengeRow {
  id: string;
  slug: string;
  title: string;
  first_day: string;
  last_day: string;
  starts_at: string;
  finishes_at: string;
  created_at: string;
}

const COLUMNS = "id, slug, title, first_day, last_day, starts_at, finishes_at, created_at";

function toChallenge(r: ChallengeRow): Challenge {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    firstDay: r.first_day,
    lastDay: r.last_day,
    startsAt: r.starts_at,
    finishesAt: r.finishes_at,
    createdAt: r.created_at,
  };
}

/** The challenge's moves, recomputed from its days (the same rules that created it). */
export function windowOf(c: Challenge): ChallengeWindow | null {
  const count = Math.round((Date.parse(c.lastDay) - Date.parse(c.firstDay)) / 86_400_000) + 1;
  return buildWindow(c.firstDay, count);
}

const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function newSlug(): string {
  return Array.from({ length: 8 }, () => SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)]).join("");
}

export type CreateResult = { ok: true; challenge: Challenge } | { ok: false; message: string };

export async function createChallenge(
  userId: string,
  title: string,
  firstDay: string,
  days: number
): Promise<CreateResult> {
  const w = challengeWindow(firstDay, days, Date.now());
  if (!w) {
    return { ok: false, message: "Those days cannot be a challenge yet: every day must already be settled." };
  }
  const admin = supabaseAdmin();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await admin
      .from("challenges")
      .insert({
        slug: newSlug(),
        title: title.trim(),
        first_day: w.days[0],
        last_day: w.days[w.days.length - 1],
        starts_at: new Date(w.startsAt).toISOString(),
        finishes_at: new Date(w.finishesAt).toISOString(),
        created_by: userId,
      })
      .select(COLUMNS)
      .single();
    if (!error) return { ok: true, challenge: toChallenge(data as ChallengeRow) };
    if (!/challenges_slug_key|duplicate key/i.test(error.message)) throw new Error(error.message);
  }
  throw new Error("could not mint a unique challenge link");
}

export async function getChallenge(slug: string): Promise<Challenge | null> {
  if (!/^[a-z0-9]{8}$/.test(slug)) return null;
  const { data, error } = await supabaseAdmin().from("challenges").select(COLUMNS).eq("slug", slug).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toChallenge(data as ChallengeRow) : null;
}

export interface ChallengeListItem extends Challenge {
  entrants: number;
  myStatus: "ACTIVE" | "FINISHED" | null;
}

export async function listChallenges(userId: string, limit = 50): Promise<ChallengeListItem[]> {
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("challenges")
    .select(`${COLUMNS}, challenge_entries(user_id, status)`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => {
    const entries = ((row as { challenge_entries?: Array<{ user_id: string; status: string }> }).challenge_entries ?? []);
    const mine = entries.find((e) => e.user_id === userId);
    return {
      ...toChallenge(row as unknown as ChallengeRow),
      entrants: entries.length,
      myStatus: (mine?.status as "ACTIVE" | "FINISHED" | undefined) ?? null,
    };
  });
}

export interface MyEntry {
  status: "ACTIVE" | "FINISHED";
  desk: Desk | null;
  pnl: string | null;
  clock: SimClock | null;
  next: ChallengeMove | null;
}

export async function getMyEntry(userId: string, challenge: Challenge): Promise<MyEntry | null> {
  const { data, error } = await supabaseAdmin()
    .from("challenge_entries")
    .select("status, desk_id, pnl")
    .eq("challenge_id", challenge.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const desk = data.desk_id ? await getOwnedDesk(userId, data.desk_id as string) : null;
  const clock = desk ? await getSimClock(desk.accountUserId) : null;
  const w = windowOf(challenge);
  return {
    status: data.status as "ACTIVE" | "FINISHED",
    desk,
    pnl: data.pnl == null ? null : String(data.pnl),
    clock,
    next: data.status === "ACTIVE" && w && clock ? nextMove(w, Date.parse(clock.now)) : null,
  };
}

/** Enter: a fresh desk, registered to the challenge with its clock at the start. */
export async function enterChallenge(userId: string, challenge: Challenge): Promise<string> {
  const { deskId } = await createDeskAccount(async (deskUserId) => {
    const { data, error } = await supabaseAdmin().rpc("enter_challenge", {
      p_owner_id: userId,
      p_challenge_id: challenge.id,
      p_desk_user_id: deskUserId,
    });
    if (error || !data) throw new Error(error?.message ?? "enter_challenge returned nothing");
    return data as string;
  });
  return deskId;
}

/**
 * Make the next move of the trader's own entry, through their own session:
 * set_sim_clock checks they own the desk (acts_for) and the challenge guard
 * refuses anything but forward, inside the challenge.
 */
export async function makeMove(userId: string, challenge: Challenge): Promise<{ ok: true } | { ok: false; message: string }> {
  const entry = await getMyEntry(userId, challenge);
  if (!entry || entry.status !== "ACTIVE" || !entry.desk) return { ok: false, message: "You have no open entry in this challenge." };
  if (!entry.next) return { ok: false, message: "Nothing left but to finish." };
  if (entry.next.kind === "finish") return { ok: false, message: "Every day has cleared: finish to settle and score." };
  const moved = await setSimClock(entry.desk.accountUserId, new Date(entry.next.at).toISOString());
  if (!moved.ok) return { ok: false, message: moved.message };
  await catchUpAccount(entry.desk.accountUserId);
  return { ok: true };
}

/** Finish: to the last day's final prices, settle, and record the result. */
export async function finishChallenge(userId: string, challenge: Challenge): Promise<{ pnl: string }> {
  const admin = supabaseAdmin();
  const { data: deskUserId, error } = await admin.rpc("challenge_advance_to_finish", {
    p_owner_id: userId,
    p_challenge_id: challenge.id,
  });
  if (error) throw new Error(error.message);
  await catchUpAccount(deskUserId as string);
  const { data, error: recordError } = await admin.rpc("challenge_record_result", {
    p_owner_id: userId,
    p_challenge_id: challenge.id,
  });
  if (recordError) throw new Error(recordError.message);
  return { pnl: String((data as { pnl: number | string }).pnl) };
}

/**
 * The standings: finished entries by P&L, then those still playing. Entering
 * a challenge puts the trader's chosen display name on it — never an email.
 */
export async function getStandings(challenge: Challenge, viewerId: string): Promise<StandingRow[]> {
  const admin = supabaseAdmin();
  const { data: entries, error } = await admin
    .from("challenge_entries")
    .select("user_id, status, pnl, finished_at")
    .eq("challenge_id", challenge.id);
  if (error) throw new Error(error.message);
  const ids = (entries ?? []).map((e) => e.user_id as string);
  const { data: profiles, error: pError } = ids.length
    ? await admin.from("profiles").select("id, display_name, username, avatar_url").in("id", ids)
    : { data: [], error: null };
  if (pError) throw new Error(pError.message);
  const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]));

  const finished = (entries ?? [])
    .filter((e) => e.status === "FINISHED")
    .sort((a, b) => Number(b.pnl) - Number(a.pnl));
  const playing = (entries ?? []).filter((e) => e.status !== "FINISHED");
  return [...finished, ...playing].map((e, i) => {
    const p = byId.get(e.user_id as string);
    return {
      rank: e.status === "FINISHED" ? i + 1 : null,
      displayName: (p?.display_name as string | null) || (p?.username as string | undefined) || "trader",
      avatarUrl: (p?.avatar_url as string | null) ?? null,
      isViewer: e.user_id === viewerId,
      status: e.status as "ACTIVE" | "FINISHED",
      pnl: e.pnl == null ? null : String(e.pnl),
      finishedAt: (e.finished_at as string | null) ?? null,
    };
  });
}
