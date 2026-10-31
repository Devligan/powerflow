import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection, LEGAL_CONTACT } from "@/components/legal-page";

export const metadata: Metadata = { title: "Terms of service · PowerFlow" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service">
      <p>
        By creating an account or using PowerFlow you agree to these terms. If
        you do not agree, please do not use the service.
      </p>

      <LegalSection heading="What PowerFlow is">
        <p>
          PowerFlow is an educational paper-trading simulator. Orders, fills,
          balances and profits are simulated. No real orders are sent to any
          market, no real money is held or moved, and PowerFlow is not a broker,
          exchange, ERCOT market participant or investment adviser.
        </p>
      </LegalSection>

      <LegalSection heading="Not advice">
        <p>
          Nothing on PowerFlow is investment, trading, financial or energy-market
          advice. Simulated results do not predict real outcomes.
        </p>
      </LegalSection>

      <LegalSection heading="Market data">
        <p>
          Prices come from public ERCOT reports and are provided as is. They may
          be delayed, corrected by ERCOT after publication, or occasionally
          missing. PowerFlow is not affiliated with or endorsed by ERCOT.
        </p>
      </LegalSection>

      <LegalSection heading="Your account">
        <p>
          Keep your sign-in details to yourself; you are responsible for activity
          on your account. Do not try to access other people&apos;s accounts, probe
          or overload the service, or use automated tools to place large volumes
          of requests. Accounts that do may be suspended or removed.
        </p>
      </LegalSection>

      <LegalSection heading="Availability and liability">
        <p>
          PowerFlow is a personal project offered free of charge and without
          warranties of any kind. It may change, pause or end at any time, and
          simulated balances may be reset. To the extent the law allows, the
          operator is not liable for any loss arising from its use.
        </p>
      </LegalSection>

      <LegalSection heading="Privacy">
        <p>
          How your data is handled is described in the{" "}
          <Link href="/privacy" className="t-accent hover:underline">privacy policy</Link>.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          <a className="t-accent hover:underline" href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>
        </p>
      </LegalSection>
    </LegalPage>
  );
}
