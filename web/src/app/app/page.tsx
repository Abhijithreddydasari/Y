"use client";

import Whiteboard from "@/components/Whiteboard";
import MobileShell from "@/components/mobile/MobileShell";
import StudioShell from "@/components/studio/StudioShell";
import { useInterfaceMode } from "@/hooks/useInterfaceMode";
import { useTutorSession } from "@/hooks/useTutorSession";
import PracticePanel from "@/components/PracticePanel";
import { useCallback, useState } from "react";
import type { WhiteboardHandle } from "@/components/Whiteboard";

export default function AppPage() {
  const session = useTutorSession();
  const interfaceMode = useInterfaceMode();
  const [board, setBoard] = useState<WhiteboardHandle | null>(null);
  const onWhiteboardReady = session.onWhiteboardReady;
  const ready = useCallback((handle: WhiteboardHandle) => { onWhiteboardReady(handle); setBoard(handle); }, [onWhiteboardReady]);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#fafafa]">
      <Whiteboard mode={interfaceMode.mode} onReady={ready} />
      <PracticePanel board={board} />
      {interfaceMode.mode === "mobile" ? (
        <MobileShell session={session} interfaceMode={interfaceMode} />
      ) : (
        <StudioShell session={session} interfaceMode={interfaceMode} />
      )}
    </main>
  );
}
