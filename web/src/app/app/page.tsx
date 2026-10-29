"use client";

import Whiteboard from "@/components/Whiteboard";
import MobileShell from "@/components/mobile/MobileShell";
import StudioShell from "@/components/studio/StudioShell";
import { useInterfaceMode } from "@/hooks/useInterfaceMode";
import { useTutorSession } from "@/hooks/useTutorSession";
import PracticePanel from "@/components/PracticePanel";

export default function AppPage() {
  const session = useTutorSession();
  const interfaceMode = useInterfaceMode();

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#fafafa]">
      <Whiteboard mode={interfaceMode.mode} onReady={session.onWhiteboardReady} />
      <PracticePanel />
      {interfaceMode.mode === "mobile" ? (
        <MobileShell session={session} interfaceMode={interfaceMode} />
      ) : (
        <StudioShell session={session} interfaceMode={interfaceMode} />
      )}
    </main>
  );
}
