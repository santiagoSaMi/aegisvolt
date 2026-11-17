import { useNavigate } from 'react-router';

import { useRuntimeConfig } from '../../shared/config/runtime-config-context.ts';
import { Alert, Button, TextField } from '../../shared/ui/components.tsx';
import { useLoginForm } from './useLoginForm.ts';

export function LoginPage() {
  const navigate = useNavigate();
  const { environment } = useRuntimeConfig();
  const form = useLoginForm(() => {
    void navigate('/dashboard', { replace: true });
  });

  return (
    <main className="login" id="main">
      <form className="login__card" onSubmit={(event) => void form.submit(event)} noValidate>
        <h1 className="login__title">AegisVolt</h1>
        <p className="login__subtitle">
          Consola de flotas eléctricas · ambiente <strong>{environment}</strong>
        </p>
        <TextField
          label="Usuario"
          name="username"
          autoComplete="username"
          value={form.values.username}
          error={form.errors.username}
          onChange={(event) => {
            form.setField('username', event.target.value);
          }}
        />
        <TextField
          label="Contraseña"
          name="password"
          type="password"
          autoComplete="current-password"
          value={form.values.password}
          error={form.errors.password}
          onChange={(event) => {
            form.setField('password', event.target.value);
          }}
        />
        {form.submitError === undefined ? null : <Alert tone="danger" title={form.submitError} />}
        <Button type="submit" loading={form.submitting}>
          Iniciar sesión
        </Button>
      </form>
    </main>
  );
}
