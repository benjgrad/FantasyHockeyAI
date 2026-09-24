// MCP step 8: which cookies page scripts can see (names only). T, A1, A3, OTH, F are HttpOnly and absent.
() => document.cookie.split(';').map((c) => c.split('=')[0].trim())
