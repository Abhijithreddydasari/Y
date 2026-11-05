import type { Metadata } from "next";
import Link from "next/link";
import { PORTRAITS } from "@/lib/discovery-portraits";
import s from "../landing.module.css";

export const metadata: Metadata = { title: "Portrait credits · Y", description: "Credits and licenses for the portraits on the Y landing page." };

export default function CreditsPage() {
  return (
    <main className={s.credits}>
      <Link href="/">← Back to Y</Link>
      <h1>Portrait credits</h1>
      <p>The closing sequence on our landing page shows these {PORTRAITS.length} scientists. Their portraits come from Wikimedia Commons and were cropped and color-graded for the page. No one shown has endorsed Y.</p>
      <ul>
        {PORTRAITS.map((person) => (
          <li key={person.frame}>
            <b>{person.name}</b> <span>{person.field}</span>
            <small>
              {person.credit} · {person.licenseUrl ? <a href={person.licenseUrl}>{person.license}</a> : person.license} · <a href={person.source}>Source</a>
            </small>
          </li>
        ))}
      </ul>
    </main>
  );
}
