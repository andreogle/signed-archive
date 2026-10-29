import { getRouteApi } from '@tanstack/react-router';
import { type JSX, useId } from 'react';
import type { MomentResponse } from '../../src/api.ts';
import { decodePrice, medianPrice } from '../../src/price.ts';
import { useCatalog, useFeeds, useHistory, useMoment, useSignatureChecks } from '../api.ts';
import { Chart } from '../components/Chart.tsx';
import { UpdatedAgo } from '../components/UpdatedAgo.tsx';
import { formatAge, formatPrice, formatTime, fromLocalInput, toLocalInput } from '../format.ts';
import { type FeedSearch, RANGES, type Range } from '../search.ts';

const route = getRouteApi('/feed');
const ENDPOINT_LABELS = { public: 'Base', 'public-oev': 'OEV' } as const;
const CHECK_LABELS = {
  pending: 'checking…',
  valid: '✓ Valid',
  'wrong-source': "✗ Not this feed's provider",
  'bad-signature': '✗ Invalid signature',
} as const;

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
              {history.data?.earliest ? (
                <>
                  {history.data.providers.length} providers · archived since {formatTime(history.data.earliest)} ·{' '}
                  <UpdatedAgo at={history.dataUpdatedAt} />
                </>
              ) : history.isPending ? (
                'Loading…'
              ) : (
                'No records archived yet'
              )}
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

function MomentPanel({ search, onTime }: { search: FeedSearch; onTime: (time: number | undefined) => void }) {
  const titleId = useId();
  const moment = useMoment(search.feed, search.endpoint, search.time);
  const data = moment.data;
  const records = data?.records ?? [];
  const catalog = useCatalog();
  const checks = useSignatureChecks(
    catalog.data,
    data?.feed ?? search.feed,
    data?.endpoint ?? search.endpoint,
    records
  );
  // Prices and the median are decoded here from the signed values, never taken from the server's strings, and the
  // median only counts records that passed the checks above.
  const verified = records.filter((_, index) => checks[index]?.data === 'valid');
  const median = medianPrice(verified);
  // A provider with more than one record signed different values for the same moment: equivocation.
  // Without a chosen time the panel follows the latest prices; ages are measured from when they were fetched.
  const live = search.time === undefined;
  const reference = search.time ?? data?.time ?? 0;
  const conflicted = new Set(
    records.map(({ provider }) => provider).filter((provider, index, all) => all.indexOf(provider) !== index)
  );

  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card-head">
        <div>
          <h2 id={titleId}>{live ? 'Latest signed prices' : 'Prices at a moment'}</h2>
          <p className="muted">
            {live ? (
              <>
                Each provider's newest signed price, refreshed every 30 seconds ·{' '}
                <UpdatedAgo at={moment.dataUpdatedAt} />
              </>
            ) : (
              "Each provider's latest signed price at or before the chosen time."
            )}
          </p>
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
          {live ? null : (
            <button type="button" onClick={() => onTime(undefined)}>
              Back to latest
            </button>
          )}
        </form>
      </div>

      {data && records.length > 0 ? (
        <div className="summary">
          <div>
            <span className="muted small">Median of verified providers</span>
            <p className="big">{median ? formatPrice(median) : '—'}</p>
          </div>
          <div>
            <span className="muted small">Signatures checked in your browser</span>
            <p className="big">
              {verified.length} / {records.length}
            </p>
          </div>
          <button type="button" onClick={() => downloadProof(data, median)}>
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
              const check = checks[index]?.data;
              const price = decodePrice(record.encodedValue);
              const age = reference - Number(record.timestamp);
              return (
                <tr key={`${record.provider}-${record.encodedValue}`}>
                  <td>
                    {record.provider}
                    {conflicted.has(record.provider) ? (
                      <span className="bad small" title="This provider signed different values for the same moment">
                        {' '}
                        ⚠ conflicting values
                      </span>
                    ) : null}
                  </td>
                  <td className="num" title={price}>
                    {formatPrice(price)}
                  </td>
                  <td title={`${formatAge(Math.max(0, age))} ${live ? 'old when fetched' : 'before the chosen time'}`}>
                    {formatTime(Number(record.timestamp))}
                  </td>
                  <td className={check === undefined ? 'muted' : check === 'valid' ? 'ok' : 'bad'}>
                    <span title={`Signer ${record.airnode}`}>{CHECK_LABELS[check ?? 'pending']}</span>
                  </td>
                </tr>
              );
            })}
            {records.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  {moment.isPending
                    ? 'Loading…'
                    : (moment.error?.message ??
                      (live ? 'No signed records archived yet.' : 'No signed records at or before this time.'))}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// `median` is the browser's own, over verified records; prices are re-decoded from the signed values.
function downloadProof(moment: MomentResponse, median: string | null) {
  const proof = {
    about:
      'Signed API3 price records. Each signature is EIP-191 over keccak256(abi.encodePacked(templateId, timestamp, encodedValue)) and must recover to airnode. ' +
      "To tie a record to the feed, airnode must be the provider's address and templateId the feed's template ID in @api3/api-integrations (for OEV data, keccak256 of it).",
    ...moment,
    median,
    records: moment.records.map((record) => ({ ...record, price: decodePrice(record.encodedValue) })),
  };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' }));
  link.download = `${moment.feed.replace('/', '-')}-${moment.time}.json`;
  link.click();
  // Revoking at once can cancel the download in some browsers; the URL only needs to outlive the click.
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
