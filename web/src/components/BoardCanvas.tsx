"use client";

// Excalidraw with the board's ☰ menu: its own items plus the local backup export, so that no longer sits on
// the board. MainMenu must be a direct child of Excalidraw to replace the default menu, so both load here.
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";

export default function BoardCanvas({ onBackup, ...props }: ExcalidrawProps & { onBackup?: () => void }) {
  return (
    <Excalidraw {...props}>
      <MainMenu>
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        {onBackup && <MainMenu.Item onSelect={onBackup}>Export board backup</MainMenu.Item>}
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  );
}
