import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

import type { UiError } from '../api/errors.ts';
import { statusInfo, type Tone } from './status.ts';

// --- Botón ------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'primary',
  loading = false,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  return (
    <button
      {...rest}
      type={type}
      className={`btn btn--${variant}`}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="spinner spinner--inline" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

// --- Contenedores -----------------------------------------------------------------

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      className={`card ${className}`}
      aria-labelledby={title === undefined ? undefined : headingId}
    >
      {title === undefined && actions === undefined ? null : (
        <header className="card__header">
          {title === undefined ? null : (
            <h2 className="card__title" id={headingId}>
              {title}
            </h2>
          )}
          {actions}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-header__title">{title}</h1>
        {description === undefined ? null : (
          <p className="page-header__description">{description}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export function KpiCard({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div className={`kpi kpi--${tone}`}>
      <span className="kpi__label">{label}</span>
      <strong className="kpi__value">{value}</strong>
      {hint === undefined ? null : <span className="kpi__hint">{hint}</span>}
    </div>
  );
}

// --- Insignias --------------------------------------------------------------------

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

/** Estado del backend con etiqueta legible y tono (el texto siempre está presente). */
export function StatusBadge({ status }: { status: string }) {
  const info = statusInfo(status);
  return (
    <span className={`badge badge--${info.tone}`} data-status={status}>
      {info.label}
    </span>
  );
}

// --- Estados de carga, vacío, error y éxito --------------------------------------

export function LoadingState({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      {children}
    </div>
  );
}

/** Error con mensaje claro y `correlation_id` para soporte; nunca detalles internos. */
export function ErrorState({
  error,
  onRetry,
}: {
  error: UiError;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{error.message}</p>
      {error.reason === undefined ? null : (
        <p className="state__meta">
          Motivo: <code>{error.reason}</code>
        </p>
      )}
      {error.correlationId === undefined ? null : (
        <p className="state__meta">
          Referencia para soporte (correlation_id): <code>{error.correlationId}</code>
        </p>
      )}
      {onRetry === undefined ? null : (
        <Button variant="secondary" onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}

export function Alert({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <strong className="alert__title">{title}</strong>
      {children === undefined ? null : <div className="alert__body">{children}</div>}
    </div>
  );
}

// --- Tabla ------------------------------------------------------------------------

export interface Column<T> {
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  readonly align?: 'start' | 'end';
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
}: {
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  empty: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={empty} />;
  }
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className="table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={column.align === 'end' ? 'num' : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.header} className={column.align === 'end' ? 'num' : undefined}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Formularios --------------------------------------------------------------------

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: (ids: { inputId: string; describedBy: string | undefined }) => ReactNode;
}) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const describedBy = [
    hint === undefined ? undefined : hintId,
    error === undefined ? undefined : errorId,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={`field${error === undefined ? '' : ' field--invalid'}`}>
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      {children({ inputId, describedBy: describedBy === '' ? undefined : describedBy })}
      {hint === undefined ? null : (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error === undefined ? null : (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function TextField({
  label,
  error,
  hint,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      {({ inputId, describedBy }) => (
        <input
          {...input}
          id={inputId}
          className="input"
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy}
        />
      )}
    </Field>
  );
}

export function SelectField({
  label,
  error,
  hint,
  options,
  placeholder,
  ...select
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      {({ inputId, describedBy }) => (
        <select
          {...select}
          id={inputId}
          className="input"
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy}
        >
          {placeholder === undefined ? null : <option value="">{placeholder}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** Interruptor accesible (role="switch"). */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  busy = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      className={`switch${checked ? ' switch--on' : ''}`}
      disabled={disabled || busy}
      onClick={() => {
        onChange(!checked);
      }}
    >
      <span className="switch__thumb" aria-hidden="true" />
      <span className="switch__text">{checked ? 'Activa' : 'Inactiva'}</span>
    </button>
  );
}

// --- Línea de tiempo ------------------------------------------------------------------

export interface TimelineItem {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly detail?: string | undefined;
}

export function Timeline({ items, label }: { items: readonly TimelineItem[]; label: string }) {
  return (
    <ol className="timeline" aria-label={label}>
      {items.map((item) => (
        <li
          key={item.key}
          className={`timeline__item timeline__item--${statusInfo(item.status).tone}`}
        >
          <span className="timeline__dot" aria-hidden="true" />
          <div>
            <span className="timeline__title">{item.title}</span>{' '}
            <StatusBadge status={item.status} />
            {item.detail === undefined ? null : <p className="timeline__detail">{item.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// --- Diálogo de confirmación -----------------------------------------------------------

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onCancel]);
  if (!open) {
    return null;
  }
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="dialog__title">
          {title}
        </h2>
        <div className="dialog__body">{children}</div>
        <div className="dialog__actions">
          <button ref={cancelRef} type="button" className="btn btn--secondary" onClick={onCancel}>
            Cancelar
          </button>
          <Button variant={tone} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
