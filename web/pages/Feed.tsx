import { getRouteApi } from '@tanstack/react-router';
import { type JSX, useId } from 'react';
import type { MomentResponse } from '../../src/api.ts';
import { useFeeds, useHistory, useMoment, useSignatureChecks } from '../api.ts';
import { Chart } from '../components/Chart.tsx';
import { formatAge, formatPrice, formatTime, fromLocalInput, toLocalInput } from '../format.ts';
import { type FeedSearch, RANGES, type Range } from '../search.ts';

const route = getRouteApi('/feed');
const ENDPOINT_LABELS = { public: 'Base', 'public-oev': 'OEV' } as const;

export function FeedPage(): JSX.Element {
  const titleId = useId();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const update = (patch: Partial<FeedSearch>) => {
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true });
  };
  const feeds = useFeeds(search.endpoint);
  const history = useHistory(search.feed, search.endpoint, search.range);

  const names = feeds.data?.feeds.map(({ feed }) => feed) ?? [];
  if (!names.includes(search.feed)) names.unshift(search.feed);
  const newest = history.data?.providers
    .flatMap(({ points }) => points.at(-1) ?? [])
    .reduce<{ timestamp: number; price: string } | null>((a, b) => (a && a.timestamp >= b.timestamp ? a : b), null);

  return (
    <>
      <section className="controls" aria-label="Choose a feed">
        <label className="field">
          <span>Feed</span>
          <select value={search.feed} onChange={(event) => update({ feed: event.target.value })}>
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Segmented
          label="Range"
          options={Object.keys(RANGES) as Range[]}
          value={search.range}
          display={(range) => range.toUpperCase()}
          onChange={(range) => update({ range })}
        />
        <Segmented
          label="Data"
          options={['public', 'public-oev'] as const}
          value={search.endpoint}
          display={(endpoint) => ENDPOINT_LABELS[endpoint]}
          onChange={(endpoint) => update({ endpoint })}
        />
      </section>

      <section className="card" aria-labelledby={titleId}>
        <div className="card-head">
          <div>
            <h2 id={titleId}>{search.feed}</h2>
            <p className="muted">
              {history.data?.earliest
                ? `${history.data.providers.length} providers · archived since ${formatTime(history.data.earliest)}`
                : history.isPending
                  ? 'Loading…'
                  : 'No records archived yet'}
            </p>
          </div>
          <p className="big">{newest ? formatPrice(newest.price) : ''}</p>
        </div>
        {history.error ? <p className="bad">{history.error.message}</p> : null}
        {history.data ? (
          <Chart
            data={history.data}
            label={`${search.feed} price over time`}
            stale={history.isPlaceholderData}
            onPick={(time) => update({ time })}
          />
        ) : null}
        <p className="muted small">Click the chart, or focus it and press Enter, to see every signed price then.</p>
      </section>

      <MomentPanel search={search} onTime={(time) => update({ time })} />
    </>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  options: readonly T[];
  value: T;
  display: (option: T) => string;
  onChange: (option: T) => void;
}

function Segmented<T extends string>({ label, options, value, display, onChange }: SegmentedProps<T>) {
  return (
    <div className="field">
      <span>{label}</span>
      <fieldset className="segmented" aria-label={label}>
        {options.map((option) => (
          <button key={option} type="button" aria-pressed={option === value} onClick={() => onChange(option)}>
            {display(option)}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

function MomentPanel({ search, onTime }: { search: FeedSearch; onTime: (time: number) => void }) {
  const titleId = useId();
  const moment = useMoment(search.feed, search.endpoint, search.time);
  const data = moment.data;
  const records = data?.records ?? [];
  const checks = useSignatureChecks(records);
  const verified = checks.filter(({ data }) => data === true).length;

  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card-head">
        <div>
          <h2 id={titleId}>Prices at a moment</h2>
          <p className="muted">Each provider's latest signed price at or before the chosen time.</p>
        </div>
        <form
          className="moment"
          key={search.time ?? 'none'}
          onSubmit={(event) => {
            event.preventDefault();
            const time = fromLocalInput(String(new FormData(event.currentTarget).get('time') ?? ''));
            if (time !== null) onTime(time);
          }}
        >
          <input
            type="datetime-local"
            name="time"
            step={1}
            required
            aria-label="Time"
            defaultValue={toLocalInput(search.time ?? Math.floor(Date.now() / 1000))}
          />
          <button type="submit" className="primary">
            Show
          </button>
        </form>
      </div>

      {data && records.length > 0 ? (
        <div className="summary">
          <div>
            <span className="muted small">Median of providers</span>
            <p className="big">{data.median ? formatPrice(data.median) : '—'}</p>
          </div>
          <div>
            <span className="muted small">Signatures checked in your browser</span>
            <p className="big">
              {verified} / {records.length}
            </p>
          </div>
          <button type="button" onClick={() => downloadProof(data)}>
            Download proof
          </button>
        </div>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th className="num">Price</th>
              <th>Signed at</th>
              <th>Signature</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record, index) => {
              const check = checks[index];
              const age = (search.time ?? 0) - Number(record.timestamp);
              return (
                <tr key={record.provider}>
                  <td>{record.provider}</td>
                  <td className="num" title={record.price}>
                    {formatPrice(record.price)}
                  </td>
                  <td title={`${formatAge(age)} before the chosen time`}>{formatTime(Number(record.timestamp))}</td>
                  <td className={check?.data === true ? 'ok' : check?.data === false ? 'bad' : 'muted'}>
                    <span title={`Signer ${record.airnode}`}>
                      {check?.data === undefined ? 'checking…' : check.data ? '✓ Valid' : '✗ Invalid'}
                    </span>
                  </td>
                </tr>
              );
            })}
            {records.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  {search.time === undefined
                    ? 'Pick a time, or click the chart.'
                    : moment.isPending
                      ? 'Loading…'
                      : (moment.error?.message ?? 'No signed records at or before this time.')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function downloadProof(moment: MomentResponse) {
  const proof = {
    about:
      'Signed API3 price records. Each signature is EIP-191 over keccak256(abi.encodePacked(templateId, timestamp, encodedValue)) and must recover to airnode.',
    ...moment,
  };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' }));
  link.download = `${moment.feed.replace('/', '-')}-${moment.time}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}
