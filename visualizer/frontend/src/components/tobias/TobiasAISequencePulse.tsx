import React, { useMemo } from 'react';
import { StepRecord, VisMachine } from '../../hooks/useMachineSimulation';
import { classifyMachine, domainColor } from '../machineDomains';

import './TobiasAISequencePulse.css';

/*
  TobiasAISequencePulse

  A compact per-step readout of which AI-machine sequences fired on each
  /api/push. The per-step WebSocket payload already carries
    step.machineResults[id].transitionResult.sequenceResults
  with matched/activated vector IDs — the StepMachineResult TypeScript
  interface doesn't expose that field, so we cast to `any` at the one
  read site rather than threading the raw payload through the hook.

  A sequence counts as "fired" when one of its matched vectors carries an
  output — same condition the hook uses to set m.justFired. The component
  shows:
    • one row per AI machine (name prefix "AI" or "localai/ai_")
    • one dot per sequence that machine owns, lit when that sequence has
      ever fired within the visible history and pulsing when it fired on
      the most recent step
    • the sequence name that fired most recently, annotated live/stale
      against the current step counter
*/

interface Props {
  stepHistory: StepRecord[];
  machines:    VisMachine[];
}

type SeqFire = {
  sequenceId:   string;
  sequenceName: string;
  step:         number;
};

const AI_MACHINE_PATTERN = /^(AI|localai\/ai_)/;
const MAX_FIRES_PER_MACHINE = 12;

function isAIMachine(m: VisMachine): boolean {
  return AI_MACHINE_PATTERN.test(m.name);
}

function displayName(m: VisMachine): string {
  return m.name.replace(/^localai\//, '').replace(/^AI/, '').slice(0, 14);
}

const TobiasAISequencePulse: React.FC<Props> = ({ stepHistory, machines }) => {
  const aiMachines = useMemo(() => machines.filter(isAIMachine), [machines]);

  const latestStep = stepHistory.length > 0
    ? stepHistory[stepHistory.length - 1].stepNumber
    : null;

  // Walk history newest → oldest; per machine collect up to N recent fires.
  const fireHistory = useMemo(() => {
    const result = new Map<string, SeqFire[]>();
    for (const m of aiMachines) {
      const fires: SeqFire[] = [];
      for (let i = stepHistory.length - 1; i >= 0; i--) {
        if (fires.length >= MAX_FIRES_PER_MACHINE) break;
        const record = stepHistory[i];
        const rawMr: any = (record.machineResults as any)[m.id];
        const seqResults: Record<string, any> =
          rawMr?.transitionResult?.sequenceResults ?? {};

        for (const [seqId, sr] of Object.entries(seqResults)) {
          const matched: string[] = (sr as any).matchedVectors ?? [];
          if (matched.length === 0) continue;

          // "Fired" means a terminal (hasOutput) vector matched.
          const seq = m.sequences.find(s => s.sequenceId === seqId);
          if (!seq) continue;
          const emittedOutput = matched.some(vid => {
            const v = seq.vectors.find(vec => vec.id === vid);
            return v?.hasOutput === true;
          });
          if (!emittedOutput) continue;

          fires.push({
            sequenceId:   seqId,
            sequenceName: seq.name,
            step:         record.stepNumber,
          });
          if (fires.length >= MAX_FIRES_PER_MACHINE) break;
        }
      }
      result.set(m.id, fires);
    }
    return result;
  }, [aiMachines, stepHistory]);

  if (aiMachines.length === 0) {
    return (
      <div className="tobias-ai-pulse">
        <div className="tobias-ai-pulse-header">
          <span className="tobias-ai-pulse-title">AI SEQUENCES</span>
        </div>
        <div className="tobias-ai-pulse-empty">
          Load the AI example machines (or drive localai/ai_load_bridge) to see firing activity.
        </div>
      </div>
    );
  }

  return (
    <div className="tobias-ai-pulse">
      <div className="tobias-ai-pulse-header">
        <span className="tobias-ai-pulse-title">AI SEQUENCES</span>
        {latestStep !== null && (
          <span className="tobias-ai-pulse-step">step {latestStep}</span>
        )}
      </div>

      <div className="tobias-ai-pulse-rows">
        {aiMachines.map(m => {
          const fires      = fireHistory.get(m.id) ?? [];
          const mostRecent = fires[0];
          const isLive     = mostRecent?.step === latestStep;

          const color = domainColor(classifyMachine(m).domain);
          return (
            <div key={m.id} className="tobias-ai-pulse-row">
              <div
                className="tobias-ai-pulse-name"
                title={m.name}
                style={{ color, borderLeft: `2px solid ${color}`, paddingLeft: 6 }}
              >
                {displayName(m)}
              </div>

              <div className="tobias-ai-pulse-dots">
                {m.sequences.map(s => {
                  const lastFire  = fires.find(f => f.sequenceId === s.sequenceId);
                  const justFired = lastFire?.step === latestStep;
                  const hasFired  = lastFire !== undefined;
                  const cls =
                    'tobias-ai-pulse-dot'
                    + (hasFired  ? ' hasFired'  : '')
                    + (justFired ? ' justFired' : '');
                  const title = lastFire
                    ? `${s.name} — last fired step ${lastFire.step}`
                    : `${s.name} — not fired in window`;
                  return <div key={s.sequenceId} className={cls} title={title} />;
                })}
              </div>

              <div className="tobias-ai-pulse-latest">
                {mostRecent ? (
                  <span
                    className={`tobias-ai-pulse-latest-name ${isLive ? 'live' : 'stale'}`}
                    title={`last fire: step ${mostRecent.step}`}
                  >
                    {mostRecent.sequenceName}
                  </span>
                ) : (
                  <span className="tobias-ai-pulse-idle">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TobiasAISequencePulse;
