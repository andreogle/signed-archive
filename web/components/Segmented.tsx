// A labelled row of toggle buttons for picking one option, such as a time range.
interface SegmentedProps<T extends string> {
  label: string;
  options: readonly T[];
  value: T;
  display: (option: T) => string;
  onChange: (option: T) => void;
}

export function Segmented<T extends string>({ label, options, value, display, onChange }: SegmentedProps<T>) {
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
