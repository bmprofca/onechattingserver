import pool from '../db.js';

async function updateDb() {
  const connection = await pool.getConnection();
  try {
    console.log("Starting DB migration...");
    
    // 1. Drop password column if exists
    try {
      await connection.query("ALTER TABLE users DROP COLUMN password");
      console.log("Dropped password column from users table.");
    } catch (e) {
      if (e.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
        console.log("Password column already dropped or does not exist.");
      } else {
        throw e;
      }
    }

    // 2. Create otp_verifications table
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS otp_verifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        mobile VARCHAR(20) NOT NULL,
        otp VARCHAR(10) NOT NULL,
        expire_date DATETIME NOT NULL,
        status ENUM('pending', 'verified') DEFAULT 'pending',
        create_date DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await connection.query(createTableSql);
    console.log("Created otp_verifications table.");

    console.log("DB migration completed successfully.");
  } catch (error) {
    console.error("DB migration failed:", error);
  } finally {
    connection.release();
    process.exit(0);
  }
}

updateDb();
