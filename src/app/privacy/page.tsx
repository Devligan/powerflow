import type { Metadata } from "next";
import { LegalPage, LegalSection, LEGAL_CONTACT } from "@/components/legal-page";

export const metadata: Metadata = { title: "Privacy policy · PowerFlow" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        PowerFlow is a paper-trading simulator for the ERCOT electricity market,
        built and run as an individual portfolio project. This page says what it
        stores about you, why, and how to have it removed.
      </p>

      <LegalSection heading="What is collected">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="t-fg">Account:</strong> your email address and, if
            you use a password, a hash of it held by our authentication provider.
            If you sign in with Google, the name, email address and profile
            picture Google shares with us.
          </li>
          <li>
            <strong className="t-fg">Profile:</strong> a username derived from your
            email address, and whether you have joined the public standings.
          </li>
          <li>
            <strong className="t-fg">Trading activity:</strong> your simulated
            orders, trades, positions, virtual cash balance and simulation-clock
            setting, plus an audit log of the actions taken on your account.
          </li>
          <li>
            <strong className="t-fg">Technical logs:</strong> our hosting providers
            record request metadata such as IP address and browser type to operate
            and secure the service.
          </li>
        </ul>
        <p>
          No payment details are ever collected: there is no real money on the
          platform. There are no advertising or analytics trackers.
        </p>
      </LegalSection>

      <LegalSection heading="How it is used">
        <p>
          Only to run your account: signing you in, executing and settling your
          paper trades, and showing your portfolio and performance. Your data is
          not sold, rented or used for advertising.
        </p>
      </LegalSection>

      <LegalSection heading="Cookies">
        <p>
          PowerFlow sets only the cookies needed to keep you signed in. They are
          HTTP-only and expire with your session.
        </p>
      </LegalSection>

      <LegalSection heading="Who else handles it">
        <p>
          Supabase (database and authentication, hosted on AWS in the United
          States) and Vercel (application hosting) process data on PowerFlow&apos;s
          behalf. Google receives your sign-in request only if you choose
          &quot;Continue with Google&quot;.
        </p>
        <p>
          The standings are opt-in. New accounts are not listed; if you join, your
          username and aggregate figures (equity, return, trade count) are visible
          to anyone viewing the standings. Your positions and individual trades
          are never shown to anyone else, and you can leave at any time.
        </p>
      </LegalSection>

      <LegalSection heading="Retention and deletion">
        <p>
          Your data is kept while your account exists. To delete your account,
          email <a className="t-accent hover:underline" href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>{" "}
          from the address you signed up with; deleting it removes your profile,
          account, positions, trades and audit history.
        </p>
      </LegalSection>

      <LegalSection heading="Market data">
        <p>
          Prices shown are public reports published by ERCOT. PowerFlow is not
          affiliated with or endorsed by ERCOT.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about this policy:{" "}
          <a className="t-accent hover:underline" href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.
          If this policy changes, the effective date above changes with it.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
