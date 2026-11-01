"use client";

import ChatPanel from "@/components/ChatPanel";
import CheckpointCard from "@/components/CheckpointCard";
import EducatorPanel from "@/components/EducatorPanel";
import LearnerPanel from "@/components/LearnerPanel";
import Toolbar from "@/components/Toolbar";
import TutorComposer from "@/components/TutorComposer";
import TutorQuestionCard from "@/components/TutorQuestionCard";
import type { useInterfaceMode } from "@/hooks/useInterfaceMode";
import type { TutorSession } from "@/hooks/useTutorSession";

interface Props {
  session: TutorSession;
  interfaceMode: ReturnType<typeof useInterfaceMode>;
}

export default function StudioShell({ session, interfaceMode }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30" data-interface="studio">
      <Toolbar
        busy={session.busy}
        narrating={session.narrating}
        status={session.status}
        ttsEnabled={session.ttsEnabled}
        teacherMode={session.teacherMode}
        modelChoice={session.modelChoice}
        modelReady={session.modelReady}
        canReplay={session.hasReplay}
        canAssess={Boolean(session.checkpoint)}
        voice={session.voice}
        onSolve={session.solve}
        onAssess={session.assess}
        onClear={session.clearBoard}
        onInsertSample={(subject) => { void session.insertSample(subject); }}
        onReplay={session.replay}
        onStop={session.stop}
        onToggleTts={session.toggleTts}
        onToggleTeacherMode={session.toggleTeacherMode}
        onModelChange={session.changeModel}
        onVoiceChange={session.changeVoice}
        onSwitchInterface={() => interfaceMode.setMode("mobile")}
      />
      <LearnerPanel snapshot={session.learnerSnapshot} onReset={() => { void session.resetLearner(); }} />
      <ChatPanel
        messages={session.chatMessages}
        busy={session.chatBusy}
        disabled={session.busy}
        sttAvailable={session.sttAvailable}
        sttModel={session.sttModel}
        onSend={(text) => { void session.sendChatMessage(text); }}
        onClear={session.clearChat}
        onCancel={session.cancelChat}
      />
      <CheckpointCard checkpoint={session.checkpoint} evidence={session.lastEvidence} />
      <TutorQuestionCard key={session.tutor.question?.qid ?? "none"} question={session.tutor.question} busy={session.busy} cardRect={session.tutor.cardRect} onAnswer={session.tutor.answer} />
      <TutorComposer tutor={session.tutor} blocked={session.busy && !session.tutor.busy} onStop={session.stop} />
      {session.teacherMode && <EducatorPanel notes={session.educatorNotes} busy={session.educatorBusy} />}
    </div>
  );
}
