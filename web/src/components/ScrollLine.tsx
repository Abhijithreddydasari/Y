"use client";

import { useEffect, useRef } from "react";

// Wavy yellow line on the left edge that "draws" itself as the user scrolls
// down the page. Pure visual flourish for the landing. Cheap to run because
// we only update one CSS property in the scroll handler.
export default function ScrollLine() {
  const ref = useRef<SVGPathElement>(null);

  useEffect(() => {
    const path = ref.current;
    if (!path) return;
    const len = path.getTotalLength();
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);

    const update = () => {
      const scrolled =
        document.documentElement.scrollTop || document.body.scrollTop || 0;
      const max =
        (document.documentElement.scrollHeight ||
          document.body.scrollHeight) - document.documentElement.clientHeight;
      const pct = max > 0 ? scrolled / max : 0;
      path.style.strokeDashoffset = String(len - len * pct);
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div className="fixed left-2 md:left-6 top-0 h-full z-0 pointer-events-none w-8 hidden sm:block">
      <svg
        className="h-full w-full"
        preserveAspectRatio="xMidYMin slice"
        viewBox="0 0 50 3000"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          ref={ref}
          d="M 25,0 Q 50,150 25,300 T 25,600 T 25,900 T 25,1200 T 25,1500 T 25,1800 T 25,2100 T 25,2400 T 25,2700 T 25,3000 T 25,3300 T 25,3600"
          fill="none"
          stroke="#f5b041"
          strokeLinecap="round"
          strokeWidth={2.5}
        />
      </svg>
    </div>
  );
}
