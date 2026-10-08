import { useState } from "react";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsRabbitSectionProps {
  readonly commandAvailable: boolean;
  readonly sessionAvailable: boolean;
  readonly onRunCommand: (command: string) => Promise<string | undefined>;
}

export function SettingsRabbitSection({
  commandAvailable,
  sessionAvailable,
  onRunCommand,
}: SettingsRabbitSectionProps) {
  const [manualPercent, setManualPercent] = useState("90");
  const [pendingCommand, setPendingCommand] = useState<string>();
  const [message, setMessage] = useState<string>();
  const manualValue = Number(manualPercent);
  const validManualValue = Number.isInteger(manualValue) && manualValue >= 1 && manualValue <= 99;
  const canRun = commandAvailable && sessionAvailable && !pendingCommand;

  const runCommand = async (command: string) => {
    setPendingCommand(command);
    setMessage(undefined);
    try {
      const error = await onRunCommand(command);
      setMessage(error ?? `Sent /rabbit ${command} to the selected session.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingCommand(undefined);
    }
  };

  return (
    <SettingsGroup
      title="Rabbit Pi Compactor"
      description="These controls update Rabbit's saved state in the selected session."
    >
      {!commandAvailable ? (
        <p className="settings-section__description" role="status">
          Rabbit is not loaded for this workspace. Enable the Rabbit extension and refresh the
          runtime to use these controls.
        </p>
      ) : !sessionAvailable ? (
        <p className="settings-section__description" role="status">
          Select a thread in this workspace before changing its compaction mode.
        </p>
      ) : null}
      <SettingsRow
        title="Compaction mode"
        description="Auto uses Rabbit's model-aware trigger. Off disables automatic compaction."
      >
        <div className="settings-row__actions">
          <button
            className="button button--secondary"
            disabled={!canRun}
            type="button"
            onClick={() => void runCommand("mode auto")}
          >
            Auto
          </button>
          <button
            aria-label="Manual compaction mode"
            className="button button--secondary"
            disabled={!canRun || !validManualValue}
            type="button"
            onClick={() => void runCommand("mode manual")}
          >
            Manual
          </button>
          <button
            className="button button--secondary"
            disabled={!canRun}
            type="button"
            onClick={() => void runCommand("mode off")}
          >
            Off
          </button>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Manual trigger"
        description="Manual starts at 90% when first enabled and keeps its saved value when reselected."
      >
        <label className="settings-number">
          <span className="sr-only">Manual trigger percentage</span>
          <input
            aria-label="Manual trigger percentage"
            disabled={!commandAvailable}
            max={99}
            min={1}
            type="number"
            value={manualPercent}
            onChange={(event) => setManualPercent(event.currentTarget.value)}
          />
          <span>%</span>
        </label>
        <button
          aria-label={`Apply manual trigger ${validManualValue ? manualValue : "invalid"} percent`}
          className="button button--secondary"
          disabled={!canRun || !validManualValue}
          type="button"
          onClick={() => void runCommand(`threshold ${manualValue}`)}
        >
          Apply percentage
        </button>
      </SettingsRow>
      <SettingsRow
        title="Context diagnostics"
        description="Rabbit reports model, usage, context window, output reserve, effective budget, trigger, armed state, compaction count and last outcome from the selected session."
      >
        <button
          className="button button--secondary"
          disabled={!canRun}
          type="button"
          onClick={() => void runCommand("status")}
        >
          Show Rabbit status
        </button>
      </SettingsRow>
      {message ? (
        <p className="settings-section__description" aria-live="polite" role="status">
          {message}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
