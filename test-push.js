require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const { rows } = await pool.query("SELECT * FROM push_subscriptions");
    console.log("Push subscriptions:", rows);
    pool.end();
}
run();
