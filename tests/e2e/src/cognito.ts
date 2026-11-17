// User Pool de Cognito en Floci para las pruebas E2E (ADR-0008): grupos
// `fleet-operators` / `platform-admins`, atributo `custom:fleet_id` y usuarios
// de prueba con contraseña fija. Solo credenciales ficticias del emulador.
import { randomUUID } from 'node:crypto';

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

export interface TestUser {
  readonly username: string;
  readonly group: 'fleet-operators' | 'platform-admins';
  readonly fleetId?: string;
}

/** Contraseña de prueba (solo para el emulador local; no es un secreto real). */
const PASSWORD = `E2e-${randomUUID().slice(0, 8)}-Aa1!`;

export class CognitoFixture {
  readonly poolId: string;
  readonly clientId: string;
  /** Contraseña ficticia de los usuarios de prueba (para el login desde el navegador). */
  readonly password: string = PASSWORD;
  private readonly client: CognitoIdentityProviderClient;

  private constructor(client: CognitoIdentityProviderClient, poolId: string, clientId: string) {
    this.client = client;
    this.poolId = poolId;
    this.clientId = clientId;
  }

  static async create(endpoint: string, users: readonly TestUser[]): Promise<CognitoFixture> {
    const client = new CognitoIdentityProviderClient({ region: 'us-east-1', endpoint });
    const pool = await client.send(
      new CreateUserPoolCommand({
        PoolName: `aegisvolt-e2e-${randomUUID().slice(0, 8)}`,
        Schema: [{ Name: 'fleet_id', AttributeDataType: 'String', Mutable: true }],
      }),
    );
    const poolId = pool.UserPool?.Id ?? '';
    const app = await client.send(
      new CreateUserPoolClientCommand({
        UserPoolId: poolId,
        ClientName: 'graphql-api-e2e',
        ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      }),
    );
    for (const group of ['fleet-operators', 'platform-admins']) {
      await client.send(new CreateGroupCommand({ UserPoolId: poolId, GroupName: group }));
    }
    for (const user of users) {
      await client.send(
        new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: user.username,
          MessageAction: 'SUPPRESS',
          UserAttributes:
            user.fleetId === undefined ? [] : [{ Name: 'custom:fleet_id', Value: user.fleetId }],
        }),
      );
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: poolId,
          Username: user.username,
          Password: PASSWORD,
          Permanent: true,
        }),
      );
      await client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: poolId,
          Username: user.username,
          GroupName: user.group,
        }),
      );
    }
    return new CognitoFixture(client, poolId, app.UserPoolClient?.ClientId ?? '');
  }

  /** ID token real emitido por Cognito (Floci) para el usuario. */
  async idToken(username: string): Promise<string> {
    const result = await this.client.send(
      new InitiateAuthCommand({
        ClientId: this.clientId,
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: username, PASSWORD },
      }),
    );
    const token = result.AuthenticationResult?.IdToken;
    if (token === undefined) {
      throw new Error(`Cognito no emitió un ID token para ${username}`);
    }
    return token;
  }

  async delete(): Promise<void> {
    await this.client
      .send(new DeleteUserPoolCommand({ UserPoolId: this.poolId }))
      .catch(() => undefined);
    this.client.destroy();
  }
}
