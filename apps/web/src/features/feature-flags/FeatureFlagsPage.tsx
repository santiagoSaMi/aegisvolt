import { toUiError } from '../../shared/api/errors.ts';
import { formatDateTime } from '../../shared/format/format.ts';
import { useViewerContext } from '../../shared/hooks/useViewerContext.ts';
import {
  Alert,
  Badge,
  Card,
  ConfirmDialog,
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  Switch,
} from '../../shared/ui/components.tsx';
import { useFeatureFlags } from './api.ts';
import { useFlagEditor } from './useFlagEditor.ts';

const SOURCE: Record<string, string> = {
  STORE: 'Tabla del ambiente',
  LAST_KNOWN: 'Último valor conocido',
  DEFAULT: 'Valor seguro por defecto',
};

/** Flags del ambiente del despliegue; edición solo para administradores (auditada). */
export function FeatureFlagsPage() {
  const viewer = useViewerContext();
  const { data, loading, error, refetch } = useFeatureFlags();
  const editor = useFlagEditor();

  return (
    <>
      <PageHeader
        title="Feature flags"
        description="Estado independiente por ambiente. Los cambios se aplican sin redesplegar y quedan auditados."
      />
      {loading && data === undefined ? <LoadingState /> : null}
      {error === undefined ? null : (
        <ErrorState error={toUiError(error)} onRetry={() => void refetch()} />
      )}
      {data === undefined ? null : (
        <>
          <Alert
            tone={data.environment === 'prod' ? 'danger' : 'info'}
            title={`Ambiente: ${data.environment}`}
          >
            Estas flags pertenecen solo a este ambiente. Cambiarlas aquí no afecta a los demás
            ambientes.
            {viewer.isAdmin ? '' : ' Solo un administrador de plataforma puede modificarlas.'}
          </Alert>
          {data.degraded ? (
            <Alert tone="warning" title="Fuente no disponible">
              Algunos valores no vienen de la tabla del ambiente (se muestran valores de respaldo).
            </Alert>
          ) : null}
          {editor.error === undefined ? null : <ErrorState error={editor.error} />}
          {editor.lastResult === undefined ? null : (
            <Alert tone="success" title={`Flag ${editor.lastResult.key} actualizada`}>
              {editor.lastResult.correlationId === undefined ? null : (
                <>
                  Auditoría con correlation_id <code>{editor.lastResult.correlationId}</code>.
                </>
              )}
            </Alert>
          )}
          <Card title="Flags">
            <DataTable
              caption="Feature flags del ambiente"
              rows={data.flags}
              rowKey={(f) => f.key}
              empty="No hay flags definidas"
              columns={[
                {
                  header: 'Flag',
                  cell: (f) => (
                    <div>
                      <code>{f.key}</code>
                      <p className="muted small">{f.description}</p>
                    </div>
                  ),
                },
                {
                  header: 'Estado',
                  cell: (f) =>
                    viewer.isAdmin ? (
                      <Switch
                        label={`${f.key}: ${f.enabled ? 'desactivar' : 'activar'}`}
                        checked={f.enabled}
                        busy={editor.saving && editor.pending?.flag.key === f.key}
                        onChange={(next) => {
                          editor.request(f, next);
                        }}
                      />
                    ) : (
                      <Badge tone={f.enabled ? 'success' : 'neutral'}>
                        {f.enabled ? 'Activa' : 'Inactiva'}
                      </Badge>
                    ),
                },
                { header: 'Origen', cell: (f) => SOURCE[f.source] ?? f.source },
                { header: 'Versión', align: 'end', cell: (f) => f.version ?? '—' },
                {
                  header: 'Último cambio',
                  cell: (f) =>
                    f.updatedAt === null
                      ? '—'
                      : `${formatDateTime(f.updatedAt)} · ${f.updatedBy ?? ''}`,
                },
              ]}
            />
          </Card>
          <ConfirmDialog
            open={editor.pending !== undefined}
            title="Confirmar cambio de flag"
            confirmLabel={editor.pending?.enabled === true ? 'Activar' : 'Desactivar'}
            tone={data.environment === 'prod' ? 'danger' : 'primary'}
            busy={editor.saving}
            onConfirm={() => void editor.confirm()}
            onCancel={editor.cancel}
          >
            <p>
              Va a <strong>{editor.pending?.enabled === true ? 'activar' : 'desactivar'}</strong>{' '}
              <code>{editor.pending?.flag.key}</code> en el ambiente{' '}
              <strong>{data.environment}</strong>. El cambio se aplica en segundos, sin redesplegar,
              y queda auditado con su usuario.
            </p>
          </ConfirmDialog>
        </>
      )}
    </>
  );
}
