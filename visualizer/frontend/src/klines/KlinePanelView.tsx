// The K-line panel (RealityEngine_Manager#372, RealityEngine_CI#603): K-line
// dynamic analysis across every registered instance.
//
//   Capture    both halves on or off, per instance or the whole universe; off
//              at boot unless the universe was started with --kline-capture
//   Knobs      klineFeedbackHops, klineStoreMaxBytes, isreStoreMaxBytes
//   Analysis   histograms over the live store or the archive, the voters side
//              by side (no reference member), followers shown but not compared
//   Archive    export into ~/.reality-engine/kline-archive and its catalog
//   Schedules  capture windows and re-runs (recomputed over records, never by
//              driving an engine), kept by Manager's backend across restarts
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ViewNav } from '../components/ViewNav';
import { Histogram } from './Histogram';
import { klineApi, type AnalysisReply, type CatalogEntry, type InstanceStatus, type PanelState, type Schedule } from './klineApi';
import './KlinePanelView.css';

const bytes = (n?: number) => n === undefined ? '—' : n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GiB`
  : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
const when = (ms?: number) => ms ? new Date(ms).toLocaleString() : '—';
const maxOf = (rows: Record<string, number>[]) => Math.max(1, ...rows.flatMap(r => Object.values(r)));
const duration = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${+(ms / 3_600_000).toFixed(1)} h`;
// Every near-miss bin, empty ones included, so a gap in the distribution shows.
const NEAR_MISS_BINS = [...Array.from({ length: 10 }, (_, i) => `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`), '1.0+'];

const Half: React.FC<{ label: string; supported: boolean; on?: boolean; error?: string }> = ({ label, supported, on, error }) => (
  <span className={`kl-half ${!supported ? 'is-unsupported' : on ? 'is-on' : 'is-off'}`} title={error}>
    <span aria-hidden="true">{!supported ? '–' : on ? '●' : '○'}</span> {label} {!supported ? 'unsupported' : on ? 'on' : 'off'}
  </span>
);

export const KlinePanelView: React.FC = () => {
  const [state, setState] = useState<PanelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisReply | null>(null);
  const [source, setSource] = useState<'store' | 'archive'>('store');
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [s, c, sc] = await Promise.all([klineApi.state(), klineApi.catalog(), klineApi.schedules()]);
      setState(s); setCatalog(c.catalog); setSchedules(sc.schedules); setError(null);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 10_000); return () => clearInterval(t); }, [refresh]);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true); setNotice(null);
    try { const r: any = await fn(); const errs = (r?.results ?? []).flatMap((x: any) => x.errors ?? (String(x.result ?? '').startsWith('refused') ? [x.result] : []));
      setNotice(errs.length ? `${what}: ${errs.join('; ')}` : `${what}: done`); }
    catch (e: any) { setNotice(`${what}: ${e.message}`); }
    finally { setBusy(false); await refresh(); }
  };

  const capture = (on: boolean, ids?: string[]) => {
    const anyOpen = (state?.instances ?? []).some(i => (ids ? ids.includes(i.id) : true) && (i.re.open ?? 0) > 0);
    if (on && anyOpen && !window.confirm('Turning capture on starts afresh: the K-lines each engine checkpointed close interrupted/shutdown. Continue?')) return;
    void act(on ? 'capture on' : 'capture off', () => klineApi.capture(on, ids));
  };

  const runAnalysis = () => act('analysis', async () => {
    const r = await klineApi.analysis(source, range.from ? Number(range.from) : undefined, range.to ? Number(range.to) : undefined);
    setAnalysis(r);
    return { results: r.errors.map(e => ({ errors: [e] })) };
  });

  const instances = state?.instances ?? [];
  const voters = instances.filter(i => i.role === 'voter');
  const followers = instances.filter(i => i.role === 'follower');

  return (
    <div className="kl-root" data-testid="kline-panel">
      <header className="kl-header">
        <ViewNav />
        <h1>K-lines</h1>
        <span className="kl-boot" data-testid="kline-boot">
          boot capture: {state?.bootCapture === null || state?.bootCapture === undefined ? 'not known' : state.bootCapture ? 'on' : 'off'}
        </span>
        {busy && <span className="kl-busy">working…</span>}
      </header>
      {error && <div className="kl-error" role="alert">{error}</div>}
      {notice && <div className="kl-notice" role="status">{notice}</div>}

      <section className="kl-section" aria-labelledby="kl-capture">
        <h2 id="kl-capture">Capture</h2>
        <p className="kl-hint">Off at boot unless the universe was started with <code>--kline-capture</code>. Switching applies to both halves at once (RE <code>klineCapture</code>, PE <code>isreCapture</code>) and is read back from each engine.</p>
        <div className="kl-actions">
          <button type="button" disabled={busy} onClick={() => capture(true)} data-testid="kline-capture-all-on">Capture on, all</button>
          <button type="button" disabled={busy} onClick={() => capture(false)} data-testid="kline-capture-all-off">Capture off, all</button>
        </div>
        <table className="kl-grid">
          <thead><tr><th>instance</th><th>role</th><th>RE</th><th>PE</th><th>open</th><th>RE store</th><th>PE store</th><th /></tr></thead>
          <tbody>{instances.map(i => (
            <tr key={i.id} data-testid={`kline-row-${i.id}`}>
              <th scope="row">{i.id} <span className="kl-muted">{i.runtime}</span></th>
              <td>{i.role}</td>
              <td><Half label="K-lines" supported={i.re.supported} on={i.re.capture} error={i.re.error} /></td>
              <td><Half label="ISRE" supported={i.pe.supported} on={i.pe.capture} error={i.pe.error} /></td>
              <td>{i.re.open ?? '—'}</td>
              <td>{bytes(i.re.stats?.bytes)} / {bytes(i.re.storeMaxBytes)}{i.re.stats?.warnings?.length ? <span className="kl-warn" title={i.re.stats.warnings.join('\n')}> ⚠ budget</span> : null}</td>
              <td>{bytes(i.pe.stats?.bytes)} / {bytes(i.pe.storeMaxBytes)}</td>
              <td>{(i.re.supported || i.pe.supported) && (
                <button type="button" disabled={busy} onClick={() => capture(!(i.re.capture || i.pe.capture), [i.id])}>
                  {i.re.capture || i.pe.capture ? 'off' : 'on'}
                </button>)}</td>
            </tr>))}</tbody>
        </table>
      </section>

      <section className="kl-section" aria-labelledby="kl-knobs">
        <h2 id="kl-knobs">Knobs</h2>
        <table className="kl-grid">
          <thead><tr><th>instance</th><th>klineFeedbackHops</th><th>klineStoreMaxBytes</th><th>isreStoreMaxBytes</th></tr></thead>
          <tbody>{instances.filter(i => i.re.supported || i.pe.supported).map(i => (
            <tr key={i.id}>
              <th scope="row">{i.id}</th>
              <td><KnobInput inst={i} knob="klineFeedbackHops" value={i.re.feedbackHops} enabled={i.re.supported} act={act} state={state} /></td>
              <td><KnobInput inst={i} knob="klineStoreMaxBytes" value={i.re.storeMaxBytes} enabled={i.re.supported} act={act} state={state} /></td>
              <td><KnobInput inst={i} knob="isreStoreMaxBytes" value={i.pe.storeMaxBytes} enabled={i.pe.supported} act={act} state={state} /></td>
            </tr>))}</tbody>
        </table>
      </section>

      <section className="kl-section" aria-labelledby="kl-analysis">
        <h2 id="kl-analysis">Analysis</h2>
        <div className="kl-filters">
          <label>source <select value={source} onChange={e => setSource(e.target.value as 'store' | 'archive')}>
            <option value="store">live store</option><option value="archive">archive</option></select></label>
          <label>from commit <input inputMode="numeric" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value.replace(/\D/g, '') }))} /></label>
          <label>to commit <input inputMode="numeric" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value.replace(/\D/g, '') }))} /></label>
          <button type="button" disabled={busy} onClick={runAnalysis} data-testid="kline-analyze">Analyse</button>
        </div>
        {analysis && <AnalysisView reply={analysis} voters={voters} followers={followers} />}
      </section>

      <section className="kl-section" aria-labelledby="kl-archive">
        <h2 id="kl-archive">Archive</h2>
        <p className="kl-hint">History is kept at <code>{state?.archive ?? '…'}</code>: one sha256-verified, read-only bundle per export, never removed by a stop or purge.</p>
        <div className="kl-actions"><button type="button" disabled={busy} onClick={() => act('archive', () => klineApi.archive())} data-testid="kline-archive-now">Archive now, all</button></div>
        <table className="kl-grid">
          <thead><tr><th>archived</th><th>instance</th><th>kind</th><th>commits</th><th>records</th><th>size</th></tr></thead>
          <tbody>{[...catalog].reverse().slice(0, 50).map(e => (
            <tr key={e.file}><td>{e.archivedAt}</td><td>{e.instanceId}</td><td>{e.kind}</td><td>{e.firstCommit}–{e.lastCommit}</td><td>{e.records.toLocaleString()}</td><td>{bytes(e.bytes)}</td></tr>))}</tbody>
        </table>
      </section>

      <section className="kl-section" aria-labelledby="kl-schedules">
        <h2 id="kl-schedules">Schedules</h2>
        <ScheduleForm instances={instances} schedules={schedules} act={act} busy={busy} />
        <table className="kl-grid">
          <thead><tr><th>schedule</th><th>targets</th><th>status</th><th>last</th><th>next</th><th /></tr></thead>
          <tbody>{schedules.map(s => <ScheduleRow key={s.id} s={s} act={act} busy={busy} />)}</tbody>
        </table>
      </section>
    </div>
  );
};

const KnobInput: React.FC<{ inst: InstanceStatus; knob: string; value?: number; enabled: boolean; state: PanelState | null;
  act: (what: string, fn: () => Promise<unknown>) => Promise<void> }> = ({ inst, knob, value, enabled, act, state }) => {
  const [draft, setDraft] = useState('');
  const spec = state?.knobs.re[knob] ?? state?.knobs.pe[knob];
  if (!enabled) return <span className="kl-muted">unsupported</span>;
  return (
    <span className="kl-knob">
      <input inputMode="numeric" placeholder={String(value ?? '')} value={draft} aria-label={`${inst.id} ${knob}`}
             onChange={e => setDraft(e.target.value.replace(/\D/g, ''))} />
      <button type="button" disabled={!draft} onClick={() => act(`${inst.id} ${knob}`, async () => {
        const r = await klineApi.setKnob(inst.id, knob, Number(draft)); setDraft(''); return { results: [r] }; })}>set</button>
      <button type="button" disabled={value === spec?.default} title={`restore ${spec?.default}`}
              onClick={() => act(`${inst.id} ${knob} default`, async () => ({ results: [await klineApi.resetKnob(inst.id, knob)] }))}>default</button>
    </span>
  );
};

const AnalysisView: React.FC<{ reply: AnalysisReply; voters: InstanceStatus[]; followers: InstanceStatus[] }> = ({ reply, voters, followers }) => {
  const per = reply.perInstance;
  const rows = useMemo(() => ([
    { key: 'byOutcome', title: 'Outcomes', orientation: 'bars' as const },
    { key: 'pathLengths', title: 'Path length (events)', orientation: 'bars' as const },
    { key: 'nearMiss', title: 'Near-miss |value − threshold| (abandoned)', orientation: 'bars' as const, order: NEAR_MISS_BINS },
    { key: 'closedPerStep', title: 'K-lines closed per step', orientation: 'columns' as const },
  ]), []);
  const group = (list: InstanceStatus[], label: string) => list.length > 0 && (
    <div className="kl-group">
      <h3>{label}</h3>
      {rows.map(r => {
        const counts = list.map(i => (per[i.id]?.klines as any)?.[r.key] ?? {});
        const top = maxOf(counts);
        return (
          <div key={r.key} className="kl-multiples">
            {list.map((i, n) => (
              <div key={i.id} className="kl-multiple">
                <div className="kl-multiple-name">{i.id}{!per[i.id] && <span className="kl-warn"> no answer</span>}</div>
                <Histogram title={r.title} counts={counts[n]} max={top} orientation={r.orientation} order={(r as { order?: string[] }).order}
                           testId={`kline-hist-${r.key}-${i.id}`} />
              </div>))}
          </div>);
      })}
      <div className="kl-multiples">
        {list.map(i => (
          <div key={i.id} className="kl-multiple">
            <div className="kl-multiple-name">{i.id}</div>
            {per[i.id]?.compositions
              ? <Histogram title="ISRE cells won by kind/provider/class" counts={per[i.id].compositions!.cellsByEntry} unit="cells" />
              : <div className="kl-empty">no ISRE composition</div>}
          </div>))}
      </div>
    </div>);
  const s = reply.sideBySide;
  return (
    <div data-testid="kline-analysis">
      <p className="kl-agree" data-testid="kline-agreement">
        voters, side by side: {s.missing.length ? <span className="kl-warn">not answered by {s.missing.join(', ')}; nothing is compared</span>
          : s.differ.length ? <><span className="kl-warn">differ on {s.differ.join(', ')}</span>{s.agree.length ? `; agree on ${s.agree.join(', ')}` : ''}</>
          : <>agree on every summary ({s.agree.join(', ')})</>}
        {' '}· {reply.source}, commits {reply.from}–{reply.to === Number.MAX_SAFE_INTEGER ? 'latest' : reply.to}
      </p>
      {reply.errors.length > 0 && <div className="kl-error">{reply.errors.join('; ')}</div>}
      {group(voters, 'Voters')}
      {group(followers, 'Followers (shown, not compared)')}
    </div>);
};

const ScheduleForm: React.FC<{ instances: InstanceStatus[]; schedules: Schedule[]; busy: boolean;
  act: (what: string, fn: () => Promise<unknown>) => Promise<void> }> = ({ schedules, busy, act }) => {
  const [kind, setKind] = useState<'capture' | 'rerun'>('capture');
  const [f, setF] = useState({ label: '', start: '', minutes: '60', steps: '', repeatHours: '', archive: true,
    source: 'archive', windowKind: 'capture', captureId: '', lastCommits: '500', everyMinutes: '' });
  const set = (k: string, v: unknown) => setF(x => ({ ...x, [k]: v }));
  const captures = schedules.filter(s => s.kind === 'capture');
  const submit = () => act('schedule', () => klineApi.addSchedule(kind === 'capture' ? {
    kind, label: f.label || undefined, targets: 'all',
    startAt: f.start ? new Date(f.start).getTime() : Date.now(),
    durationMs: f.minutes ? Number(f.minutes) * 60_000 : undefined, steps: f.steps ? Number(f.steps) : undefined,
    repeatEveryMs: f.repeatHours ? Number(f.repeatHours) * 3_600_000 : undefined, archiveAtEnd: f.archive,
  } : {
    kind, label: f.label || undefined, targets: 'all', source: f.source,
    window: f.windowKind === 'capture' ? { captureId: f.captureId || captures[captures.length - 1]?.id } : { lastCommits: Number(f.lastCommits) },
    everyMs: f.everyMinutes ? Number(f.everyMinutes) * 60_000 : undefined, nextRunAt: Date.now(),
  }));
  return (
    <div className="kl-filters" data-testid="kline-schedule-form">
      <label>new <select value={kind} onChange={e => setKind(e.target.value as 'capture' | 'rerun')}>
        <option value="capture">capture window</option><option value="rerun">re-run</option></select></label>
      <label>label <input value={f.label} onChange={e => set('label', e.target.value)} /></label>
      {kind === 'capture' ? <>
        <label>start <input type="datetime-local" value={f.start} onChange={e => set('start', e.target.value)} /></label>
        <label>minutes <input inputMode="numeric" value={f.minutes} onChange={e => set('minutes', e.target.value.replace(/\D/g, ''))} /></label>
        <label>or steps <input inputMode="numeric" value={f.steps} onChange={e => set('steps', e.target.value.replace(/\D/g, ''))} /></label>
        <label>repeat every h <input inputMode="numeric" value={f.repeatHours} onChange={e => set('repeatHours', e.target.value.replace(/\D/g, ''))} /></label>
        <label><input type="checkbox" checked={f.archive} onChange={e => set('archive', e.target.checked)} /> archive at end</label>
      </> : <>
        <label>source <select value={f.source} onChange={e => set('source', e.target.value)}><option value="archive">archive</option><option value="store">live store</option></select></label>
        <label>over <select value={f.windowKind} onChange={e => set('windowKind', e.target.value)}><option value="capture">a capture window</option><option value="last">latest commits</option></select></label>
        {f.windowKind === 'capture'
          ? <label>window <select value={f.captureId} onChange={e => set('captureId', e.target.value)}>
              <option value="">latest capture</option>{captures.map(c => <option key={c.id} value={c.id}>{c.label ?? c.id.slice(0, 8)}</option>)}</select></label>
          : <label>commits <input inputMode="numeric" value={f.lastCommits} onChange={e => set('lastCommits', e.target.value.replace(/\D/g, ''))} /></label>}
        <label>every min <input inputMode="numeric" placeholder="once" value={f.everyMinutes} onChange={e => set('everyMinutes', e.target.value.replace(/\D/g, ''))} /></label>
      </>}
      <button type="button" disabled={busy || (kind === 'rerun' && f.windowKind === 'capture' && captures.length === 0)} onClick={submit}>add</button>
    </div>);
};

const ScheduleRow: React.FC<{ s: Schedule; busy: boolean; act: (what: string, fn: () => Promise<unknown>) => Promise<void> }> = ({ s, busy, act }) => {
  const last = s.kind === 'capture' ? s.windows?.[s.windows.length - 1] : undefined;
  const result = s.kind === 'rerun' ? s.results?.[s.results.length - 1] : undefined;
  const summary = s.kind === 'capture'
    ? (last ? `${when(last.startedAt)}${last.endedAt ? ` – ${when(last.endedAt)}` : ' (open)'}${last.errors.length ? ` ⚠ ${last.errors.join('; ')}` : ''}` : '—')
    : (result ? `${when(result.at)}: ${result.sideBySide?.missing?.length ? `not answered by ${result.sideBySide.missing.join(', ')}`
        : result.sideBySide?.differ?.length ? `voters differ on ${result.sideBySide.differ.join(', ')}` : 'voters agree'}` : '—');
  const describe = s.kind === 'capture'
    ? `capture ${s.durationMs ? duration(s.durationMs) : ''}${s.steps ? ` / ${s.steps} steps` : ''}${s.repeatEveryMs ? `, every ${duration(s.repeatEveryMs)}` : ''}${s.archiveAtEnd ? ', archived' : ''}`
    : `re-run over ${s.window && 'captureId' in s.window ? 'a capture window' : `latest ${(s.window as any)?.lastCommits} commits`} (${s.source})${s.everyMs ? `, every ${duration(s.everyMs)}` : ''}`;
  return (
    <tr>
      <th scope="row">{s.label ?? s.id.slice(0, 8)} <span className="kl-muted">{describe}</span></th>
      <td>{s.targets === 'all' ? 'all' : s.targets.join(', ')}</td>
      <td>{s.status}</td>
      <td>{summary}</td>
      <td>{s.kind === 'capture' ? (s.status === 'pending' ? when(s.startAt) : '—') : (s.status === 'pending' ? when(s.nextRunAt) : '—')}</td>
      <td>
        {s.kind === 'rerun' && <button type="button" disabled={busy} onClick={() => act('re-run', () => klineApi.runSchedule(s.id))}>run now</button>}
        <button type="button" disabled={busy} onClick={() => act('remove', () => klineApi.removeSchedule(s.id))}>remove</button>
      </td>
    </tr>);
};

export default KlinePanelView;
