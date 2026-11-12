// The service-role duties of the end-to-end checks (scripts/e2e/*.ts), done
// over the database connection the migration runner uses: a throwaway user
// created and removed directly, so the checks need no service-role key.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";

for (const line of readFileSync(".env", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

/**
 * JSON from the site's API, walked loosely: these checks assert on a few
 * fields of many response shapes, and a failed lookup is itself a failed
 * check rather than a type error worth modelling.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any;

export async function db(): Promise<Client> {
  const ref =
    process.env.SUPABASE_PROJECT_REF ||
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  const client = new Client({
    host: "aws-0-us-west-2.pooler.supabase.com",
    port: 5432,
    user: `postgres.${ref}`,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

/**
 * A confirmed, onboarded throwaway user that can sign in with a password, as
 * Supabase seeds create them: the Auth row (bcrypt via pgcrypto) and its
 * email identity. handle_new_user bootstraps the profile and the account.
 */
export async function createTestUser(c: Client, prefix: string): Promise<{ id: string; email: string; password: string }> {
  const id = randomUUID();
  const email = `${prefix}.${Date.now()}@powerflow.test`;
  const password = `E2e-${randomUUID()}`;
  await c.query("begin");
  try {
    await c.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
         confirmation_token, recovery_token, email_change_token_new, email_change)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
         extensions.crypt($3, extensions.gen_salt('bf')), now(),
         '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')`,
      [id, email, password]
    );
    await c.query(
      `insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       values ($1::uuid, $1::uuid, $2::text, jsonb_build_object('sub', $2::text, 'email', $3::text), 'email', now(), now(), now())`,
      [id, id, email]
    );
    await c.query(
      `update public.profiles set display_name = 'E2E', onboarded_at = now(), leaderboard_opt_in = false where id = $1`,
      [id]
    );
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
  return { id, email, password };
}

/** Delete the user; its desks (0048 trigger) and every book go with it. */
export async function deleteTestUser(c: Client, id: string): Promise<{ desksLeft: number }> {
  const { rows: desks } = await c.query<{ desk_user_id: string }>("select desk_user_id from public.desks where owner_id = $1", [id]);
  await c.query("delete from auth.users where id = $1", [id]);
  const { rows } = await c.query<{ n: string }>(
    "select count(*) as n from public.paper_accounts where user_id = any($1::uuid[])",
    [desks.map((d) => d.desk_user_id)]
  );
  return { desksLeft: Number(rows[0].n) };
}
