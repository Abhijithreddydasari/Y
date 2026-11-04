// Y's mark, the soft ribbon: a left arm folding under the right arm, and a curved cut above the stem. Shaded yellow on
// light or dark surfaces, plain ink on a yellow surface. `app/icon.svg` holds the same paths for the browser tab.
import { useId } from "react";

const LEFT = "M40 80C85 62 150 65 190 70C260 78 310 105 345 155L445 310L392 392C365 410 340 435 322 468C280 325 145 170 40 80Z";
const RIGHT = "M822 72L660 72C615 72 585 95 560 130L385 398C470 345 600 320 672 275C710 250 740 200 822 72Z";
const STEM = "M700 255C640 320 480 365 395 420C345 455 322 495 322 550L322 750L420 750C470 750 497 720 497 670L497 560C497 510 525 465 570 410Z";
const FACET = "M322 750C370 660 430 600 497 548L497 670C497 720 470 750 420 750Z";
const INK = "#17140A";

export default function YMark({ size = 24, tone = "yellow", className }: { size?: number; tone?: "yellow" | "ink"; className?: string }) {
  // Unique per instance: a shared gradient id breaks when the first mark on the page is hidden.
  const id = useId();
  const svgProps = { "data-testid": "y-mark", "aria-hidden": true, viewBox: "0 0 860 780", width: size, height: Math.round((size * 780) / 860), className };
  if (tone === "ink") {
    return <svg {...svgProps}><path fill={INK} d={LEFT} /><path fill={INK} d={RIGHT} /><path fill={INK} d={STEM} /></svg>;
  }
  return (
    <svg {...svgProps}>
      <defs>
        <linearGradient id={`${id}l`} gradientUnits="userSpaceOnUse" x1="70" y1="70" x2="420" y2="390">
          <stop offset="0" stopColor="#FFC400" /><stop offset=".45" stopColor="#FFCB2E" /><stop offset=".78" stopColor="#FFBD00" /><stop offset="1" stopColor="#E9A000" />
        </linearGradient>
        <linearGradient id={`${id}r`} gradientUnits="userSpaceOnUse" x1="420" y1="370" x2="800" y2="80">
          <stop offset="0" stopColor="#FFDC5C" /><stop offset=".55" stopColor="#FFCF36" /><stop offset="1" stopColor="#FFC400" />
        </linearGradient>
        <linearGradient id={`${id}s`} gradientUnits="userSpaceOnUse" x1="660" y1="280" x2="330" y2="660">
          <stop offset="0" stopColor="#FFBE00" /><stop offset=".6" stopColor="#FFC400" /><stop offset="1" stopColor="#FFCF36" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id}l)`} d={LEFT} />
      <path fill={`url(#${id}r)`} d={RIGHT} />
      <path fill={`url(#${id}s)`} d={STEM} />
      <path fill="#FFBF00" d={FACET} />
    </svg>
  );
}
