DROP TABLE IF EXISTS mcp_tokens;
DROP TABLE IF EXISTS homeworks;
DROP TABLE IF EXISTS users;

-- 创建 users 表
CREATE TABLE users (
    username VARCHAR(255) PRIMARY KEY,
    password VARCHAR(255),
    userinfo TEXT
);

-- 创建 homeworks 表
CREATE TABLE homeworks (
    id VARCHAR(255) PRIMARY KEY,
    info TEXT
);

-- 创建 mcp_tokens 表
CREATE TABLE mcp_tokens (
    token    VARCHAR(255) PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);