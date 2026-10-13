import { describe, expect, it } from 'vitest';
import { extractOtherCookies, extractYahooCookies } from './yahooPaste';

// Shaped like real Yahoo values (they contain `=` and `&`), but synthetic.
const T = 'z=abcDEF123&a=QAE&sk=DAAxyz&ks=EAAq--~G&kt=EAAv&ku=FAAw&d=dGlw&af=JnRzPTE';
const Y = 'v=1&n=0abc123def&l=h8k3/o&o=0&r=1f&intl=us';
const JAR = `A1=d=AQABBxyz&S=AQAAA; A3=d=AQAB; OTH=v=2&s=2; T=${T}; Y=${Y}; AWSALBTG=abcdef0123456789`;

describe('extractYahooCookies', () => {
  it('reads Chrome "Copy as cURL (bash)" with -b', () => {
    const curl = `curl 'https://hockey.fantasysports.yahoo.com/hockey/48535/6' \\\n  -H 'accept: text/html' \\\n  -b '${JAR}' \\\n  -H 'user-agent: Mozilla/5.0'`;
    expect(extractYahooCookies(curl)).toEqual({ T, Y });
  });

  it('reads the -H "cookie: …" form', () => {
    expect(extractYahooCookies(`curl 'https://x' -H 'cookie: ${JAR}'`)).toEqual({ T, Y });
  });

  it('reads Windows cmd cURL with ^ escaping', () => {
    const cmd = `curl ^"https://x^" -b ^"${JAR.replace(/&/g, '^&').replace(/=/g, '=')}^"`;
    expect(extractYahooCookies(cmd)).toEqual({ T, Y });
  });

  it('reads PowerShell', () => {
    const ps = `$session.Cookies.Add((New-Object System.Net.Cookie("T", "${T}", "/", ".yahoo.com")))\n$session.Cookies.Add((New-Object System.Net.Cookie("Y", "${Y}", "/", ".yahoo.com")))`;
    expect(extractYahooCookies(ps)).toEqual({ T, Y });
  });

  it('reads "Copy as fetch" JSON headers', () => {
    const f = `fetch("https://x", { "headers": { "cookie": "${JAR}" } });`;
    expect(extractYahooCookies(f)).toEqual({ T, Y });
  });

  it('reads a bare cookie string and a two-line paste', () => {
    expect(extractYahooCookies(JAR)).toEqual({ T, Y });
    expect(extractYahooCookies(`T=${T}\nY=${Y}`)).toEqual({ T, Y });
  });

  it('never mistakes a longer cookie name for T or Y', () => {
    expect(extractYahooCookies('AT=zzzzzzzzzzzzzz; OTH=v=2&s=2; YY=aaaaaaaaaaaaa')).toEqual({});
  });

  it('reports what is missing, e.g. a console document.cookie copy without the HttpOnly T', () => {
    expect(extractYahooCookies(`A3=x; Y=${Y}; F=d=abc`)).toEqual({ Y });
  });
});

describe('extractOtherCookies (D-033)', () => {
  const OTHERS = {
    A1: 'd=AQABBxyz&S=AQAAA',
    A3: 'd=AQAB',
    OTH: 'v=2&s=2',
    AWSALBTG: 'abcdef0123456789',
  };

  it('reads every cookie but T and Y from each copy format', () => {
    const bash = `curl 'https://x' \\\n  -H 'accept: text/html' \\\n  -b '${JAR}' \\\n  -H 'user-agent: M'`;
    expect(extractOtherCookies(bash)).toEqual(OTHERS);
    expect(extractOtherCookies(`curl 'https://x' -H 'cookie: ${JAR}'`)).toEqual(OTHERS);
    expect(extractOtherCookies(`curl ^"https://x^" -b ^"${JAR.replace(/&/g, '^&')}^"`)).toEqual(
      OTHERS,
    );
    expect(
      extractOtherCookies(`fetch("https://x", { "headers": { "cookie": "${JAR}" } });`),
    ).toEqual(OTHERS);
    expect(extractOtherCookies(JAR)).toEqual(OTHERS);
  });

  it('reads PowerShell cookies and skips malformed ones', () => {
    const ps = `New-Object System.Net.Cookie("A3", "d=AQAB", "/", ".yahoo.com")\nNew-Object System.Net.Cookie("T", "${T}", "/", ".yahoo.com")`;
    expect(extractOtherCookies(ps)).toEqual({ A3: 'd=AQAB' });
    expect(extractOtherCookies('A3=; bad name=x; ok=1')).toEqual({ ok: '1' });
    expect(extractOtherCookies("curl 'https://x' -H 'accept: */*'")).toEqual({});
  });
});
