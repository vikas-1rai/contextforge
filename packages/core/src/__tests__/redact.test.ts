import { redactSecrets, containsSecret } from '../redaction';

describe('redactSecrets', () => {
  it('masks password assignments (json and env style)', () => {
    expect(redactSecrets('"password": "hunter2"')).toBe('"password": "[REDACTED]"');
    expect(redactSecrets('PASSWORD=hunter2')).toBe('PASSWORD=[REDACTED]');
    expect(redactSecrets('pwd = s3cr3t!')).toBe('pwd = [REDACTED]');
  });

  it('masks common secret key names', () => {
    expect(redactSecrets('api_key: abc123XYZ')).toBe('api_key: [REDACTED]');
    expect(redactSecrets('client_secret=verysecretvalue')).toBe('client_secret=[REDACTED]');
    expect(redactSecrets('access_token: "tok_abc.def"')).toBe('access_token: "[REDACTED]"');
  });

  it('masks credentials embedded in connection strings', () => {
    expect(redactSecrets('postgres://admin:p4ssw0rd@db.internal:5432/app')).toBe(
      'postgres://admin:[REDACTED]@db.internal:5432/app',
    );
  });

  it('masks bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abcDEF123456ghiJKL')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4';
    expect(redactSecrets(`token is ${jwt}`)).toBe('token is [REDACTED_JWT]');
  });

  it('masks provider token prefixes', () => {
    expect(redactSecrets('use ghp_0123456789abcdefghijklmnopqrstuvwx')).toContain('[REDACTED_TOKEN]');
    expect(redactSecrets('key sk-0123456789abcdefghijklmnop')).toContain('[REDACTED_TOKEN]');
    expect(redactSecrets('id AKIAABCDEFGHIJKLMNOP')).toContain('[REDACTED_TOKEN]');
  });

  it('masks PEM private key blocks', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef==\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`here: ${key}`)).toBe('here: [REDACTED_PRIVATE_KEY]');
  });

  it('leaves ordinary prompt text untouched', () => {
    const text = 'Refactor the getTopPrompts function to add a time window filter.';
    expect(redactSecrets(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it('containsSecret detects when a value would be masked', () => {
    expect(containsSecret('password=hunter2')).toBe(true);
    expect(containsSecret('just a normal sentence')).toBe(false);
  });

  it('handles empty input', () => {
    expect(redactSecrets('')).toBe('');
    expect(containsSecret('')).toBe(false);
  });
});
