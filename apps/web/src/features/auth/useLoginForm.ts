import { useState, type SubmitEvent } from 'react';
import { z } from 'zod';

import { AuthError } from '../../shared/auth/cognito-client.ts';
import { useAuth } from '../../shared/auth/auth-context.ts';

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Ingrese su usuario').max(128),
  password: z.string().min(1, 'Ingrese su contraseña').max(256),
});

type Field = 'username' | 'password';

/** Estado y envío del formulario de acceso (la identidad la valida Cognito). */
export function useLoginForm(onSuccess: () => void) {
  const { signIn } = useAuth();
  const [values, setValues] = useState({ username: '', password: '' });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const setField = (field: Field, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setSubmitError(undefined);
    const parsed = loginSchema.safeParse(values);
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        next[issue.path[0] as Field] = issue.message;
      }
      setErrors(next);
      return;
    }
    setSubmitting(true);
    try {
      await signIn(parsed.data.username, parsed.data.password);
      onSuccess();
    } catch (error) {
      setSubmitError(error instanceof AuthError ? error.message : 'No se pudo iniciar sesión');
    } finally {
      setSubmitting(false);
    }
  };

  return { values, errors, submitError, submitting, setField, submit };
}
