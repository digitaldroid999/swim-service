// Test environment setup - runs before each test file's module registry is initialized.
// Sets env vars so db.js opens an in-memory SQLite database instead of a file.
process.env.DB_PATH = ':memory:';
process.env.API_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
