import { cache } from "react";
import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { requireUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Desks: the engine accounts a trader acts for (0048).
 *
 * Every trader has their live account. They may also own a practice desk — a
 * second account with its own $100,000 and its own clock — so replaying the
 * past never touches the live book or its place on the standings. A desk is
 * an auth user of its own that never signs in; the engine lets the owner's
 * session act for it (`acts_for`), so ownership is checked in the database,
 * not only here.
 *
 * The desk being traded is a cookie holding a desk id. It is only a choice
 * among the caller's own desks: an id they do not own resolves to live.
 */

export const DESK_COOKIE = "pf_desk";

export const DESK_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

export type DeskKind = "LIVE" | "PRACTICE" | "CHALLENGE";

export interface Desk {
  /** desks.id, or null for the live account. */
  id: string | null;
  kind: DeskKind;
  /** The account the engine trades: the trader's own id on the live desk. */
  accountUserId: string;
  label: string;
  /** The challenge a CHALLENGE desk is entered in (0049). */
  challenge: { slug: string; title: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Desk users get an address that can never receive mail. */
const DESK_EMAIL_DOMAIN = "desks.powerflow.invalid";

export function liveDesk(userId: string): Desk {
  return { id: null, kind: "LIVE", accountUserId: userId, label: "Live", challenge: null };
}

type ChallengeRef = { challenges: { slug: string; title: string } | null };

interface DeskRow {
  id: string;
  desk_user_id: string;
  kind: "PRACTICE" | "CHALLENGE";
  challenge_entries?: ChallengeRef | ChallengeRef[] | null;
}

function toDesk(row: DeskRow): Desk {
  const entry = Array.isArray(row.challenge_entries) ? row.challenge_entries[0] : row.challenge_entries;
  const challenge = entry?.challenges ?? null;
  return {
    id: row.id,
    kind: row.kind,
    accountUserId: row.desk_user_id,
    label: row.kind === "PRACTICE" ? "Practice" : `Challenge${challenge ? ` · ${challenge.title}` : ""}`,
    challenge,
  };
}

const DESK_COLUMNS = "id, desk_user_id, kind, challenge_entries(challenges(slug, title))";

/** The desk the caller is trading, per request. */
export const getActiveDesk = cache(async (userId: string): Promise<Desk> => {
  const store = await cookies();
  const id = store.get(DESK_COOKIE)?.value;
  if (!id || !UUID.test(id)) return liveDesk(userId);
  const { data, error } = await supabaseAdmin()
    .from("desks")
    .select(DESK_COLUMNS)
    .eq("id", id)
    .eq("owner_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toDesk(data as unknown as DeskRow) : liveDesk(userId);
});

/** A desk the caller owns, by id, or null. */
export async function getOwnedDesk(ownerId: string, deskId: string): Promise<Desk | null> {
  if (!UUID.test(deskId)) return null;
  const { data, error } = await supabaseAdmin()
    .from("desks")
    .select(DESK_COLUMNS)
    .eq("id", deskId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toDesk(data as unknown as DeskRow) : null;
}

/** For desk pages: the signed-in trader and the desk they are trading. */
export async function requireDesk(): Promise<{ user: User; desk: Desk }> {
  const user = await requireUser();
  return { user, desk: await getActiveDesk(user.id) };
}

export async function getPracticeDesk(ownerId: string): Promise<Desk | null> {
  const { data, error } = await supabaseAdmin()
    .from("desks")
    .select("id, desk_user_id, kind")
    .eq("owner_id", ownerId)
    .eq("kind", "PRACTICE")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toDesk(data as unknown as DeskRow) : null;
}

/**
 * A new desk account: an Auth user (so handle_new_user gives it a profile,
 * $100,000 and a clock), then registered by `register` — which names the
 * owner, and for a challenge enters it. A failed registration removes the
 * user again rather than leaving an account nobody owns.
 */
export async function createDeskAccount(
  register: (deskUserId: string) => Promise<string>
): Promise<{ deskId: string; deskUserId: string }> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.createUser({
    email: `desk-${crypto.randomUUID()}@${DESK_EMAIL_DOMAIN}`,
    email_confirm: true,
    app_metadata: { desk: true },
  });
  if (error || !data.user) throw new Error(`desk user: ${error?.message ?? "not created"}`);
  const deskUserId = data.user.id;
  try {
    return { deskId: await register(deskUserId), deskUserId };
  } catch (e) {
    await admin.auth.admin.deleteUser(deskUserId).catch(() => undefined);
    throw e;
  }
}

async function createPracticeDesk(ownerId: string): Promise<Desk> {
  const { deskId, deskUserId } = await createDeskAccount(async (deskUserId) => {
    const { data: id, error } = await supabaseAdmin().rpc("register_desk", {
      p_owner_id: ownerId,
      p_desk_user_id: deskUserId,
      p_kind: "PRACTICE",
    });
    if (error || !id) throw new Error(`desk registration: ${error?.message ?? "no id"}`);
    return id as string;
  });
  return toDesk({ id: deskId, desk_user_id: deskUserId, kind: "PRACTICE" });
}

/** The trader's practice desk, created on first use. */
export async function ensurePracticeDesk(ownerId: string): Promise<Desk> {
  const existing = await getPracticeDesk(ownerId);
  if (existing) return existing;
  try {
    return await createPracticeDesk(ownerId);
  } catch (e) {
    // Two first uses at once: one registration wins the unique index.
    const winner = await getPracticeDesk(ownerId);
    if (winner) return winner;
    throw e;
  }
}

/**
 * Start practice over: the desk row goes, its user with it (0048's trigger),
 * and the whole practice book through the existing cascades.
 */
export async function deletePracticeDesk(ownerId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("desks")
    .delete()
    .eq("owner_id", ownerId)
    .eq("kind", "PRACTICE");
  if (error) throw new Error(error.message);
}
