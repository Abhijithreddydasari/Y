// Y's mark, the "Fold": a darker left arm folding under the right arm and stem. Yellow on light or dark surfaces, ink on
// a yellow surface. `app/app/icon.svg` holds the same paths for the browser tab.
const TONES = {
  yellow: { arm: "#E8AC00", body: "#FFC400" },
  ink: { arm: "#3D3510", body: "#17140A" },
};

export default function YMark({ size = 24, tone = "yellow", className }: { size?: number; tone?: keyof typeof TONES; className?: string }) {
  const { arm, body } = TONES[tone];
  return (
    <svg data-testid="y-mark" aria-hidden="true" viewBox="0 0 128 116" width={size} height={Math.round((size * 116) / 128)} className={className}>
      <path fill={arm} d="M7 10C14 7.5 19 8 23 8C34 8 42 12 50 23L66 44L50 63L31 36C23 24 15 14 7 10Z" />
      <path fill={body} d="M121 9L100 9C92 9 87 13 83 19L56 56C68 47 82 44 92 40C99 37 104 33 108 29Z" />
      <path fill={body} d="M103 36C92 47 74 51 62 59C52 65 47 72 47 80L47 108L62 108C69 108 74 103 74 96L74 80C74 72 78 65 83 60Z" />
    </svg>
  );
}
