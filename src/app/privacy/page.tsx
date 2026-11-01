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
            PowerFlow itself never stores or logs your password, and changes to
            your email or password are confirmed through your inbox.
            If you sign in with Google, the name, email address and profile
            picture Google shares with us.
          </li>
          <li>
            <strong className="t-fg">Profile:</strong> the display name and
            username you choose, an optional profile picture, and whether you
            have joined the public standings. Neither name is derived from your
            email address, and pictures you upload are cropped and stripped of
            their metadata (such as location) before they leave your browser.
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
          The standings are opt-in. New accounts are private and not listed; if
          you join, your display name, profile picture and aggregate figures
          (equity, return, trade count) are visible to anyone viewing the
          standings. Your email address, username, positions and individual
          trades are never shown to anyone else, and you can make your account
          private again at any time in Settings.
        </p>
      </LegalSection>

      <LegalSection heading="Retention and deletion">
        <p>
          Your data is kept while your account exists. You can delete your
          account yourself at any time under Settings → Delete account; this
          permanently removes your profile, picture, paper account, orders,
          positions, trades and audit history. You can also download your trade
          history there first. If you cannot sign in, email{" "}
          <a className="t-accent hover:underline" href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>{" "}
          from the address you signed up with.
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
