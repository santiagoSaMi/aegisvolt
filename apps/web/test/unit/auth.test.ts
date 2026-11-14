import { describe, expect, it } from 'vitest';

import { AuthError, createCognitoClient } from '../../src/shared/auth/cognito-client.ts';
import { sessionStore } from '../../src/shared/auth/session-store.ts';

function fakeFetch(
  status: number,
  body: unknown,
  seen?: { init?: RequestInit | undefined },
): typeof fetch {
  return (_input, init) => {
    if (seen !== undefined) seen.init = init;
    return Promise.resolve(Response.json(body, { status }));
  };
}

describe('createCognitoClient', () => {
  it('inicia sesión con USER_PASSWORD_AUTH y devuelve el ID token con su vencimiento', async () => {
    const seen: { init?: RequestInit | undefined } = {};
    const client = createCognitoClient({
      cognitoUrl: './auth/cognito',
      clientId: 'client-1',
      now: () => 1_000,
      fetch: fakeFetch(200, { AuthenticationResult: { IdToken: 'id.jwt', ExpiresIn: 60 } }, seen),
    });

    await expect(client.signIn('ana', 'secreta')).resolves.toEqual({
      idToken: 'id.jwt',
      expiresAt: 61_000,
      username: 'ana',
    });
    expect(new Headers(seen.init?.headers).get('x-amz-target')).toBe(
      'AWSCognitoIdentityProviderService.InitiateAuth',
    );
    expect(JSON.parse(seen.init?.body as string)).toMatchObject({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: 'client-1',
    });
  });

  it.each([
    [400, { __type: 'NotAuthorizedException' }, 'INVALID_CREDENTIALS'],
    [400, { __type: 'UserNotFoundException' }, 'INVALID_CREDENTIALS'],
    [500, {}, 'UNAVAILABLE'],
    [200, { ChallengeName: 'NEW_PASSWORD_REQUIRED' }, 'CHALLENGE_REQUIRED'],
  ])('HTTP %i %j → %s', async (status, body, kind) => {
    const client = createCognitoClient({
      cognitoUrl: 'x',
      clientId: 'c',
      fetch: fakeFetch(status, body),
    });
    await expect(client.signIn('a', 'b')).rejects.toMatchObject({ kind });
  });

  it('un fallo de red es UNAVAILABLE', async () => {
    const client = createCognitoClient({
      cognitoUrl: 'x',
      clientId: 'c',
      fetch: () => Promise.reject(new TypeError('down')),
    });
    await expect(client.signIn('a', 'b')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('sessionStore', () => {
  it('guarda, carga y descarta sesiones vencidas', () => {
    sessionStore.save({ idToken: 't', expiresAt: 2_000, username: 'ana' });
    expect(sessionStore.load(1_000)).toMatchObject({ username: 'ana' });
    expect(sessionStore.load(3_000)).toBeUndefined();
    expect(sessionStorage.length).toBe(0);
  });

  it('ignora contenido corrupto', () => {
    sessionStorage.setItem('aegisvolt.session', '{no-json');
    expect(sessionStore.load()).toBeUndefined();
  });
});
