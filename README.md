# @bkmj/node-red-contrib-mssqlmj

A high-performance, robust Microsoft SQL Server node for Node-RED, built directly on top of the native `tedious` driver. 

Designed specifically to address extreme latency on WAN/VPN connections by bypassing the overhead of session resets (`sp_reset_connection`) found in standard `node-mssql` wrappers.

## Features

* **Ultra-Fast Executions**: Executes raw T-SQL directly via Tedious `execSql()`, reducing network round-trips from ~7 down to 1 per query.
* **Native Parameters**: Secure your queries against SQL injection. Automatically infers Tedious types (NVarChar, Int, Float, Bit, DateTime) directly from `msg.params`.
* **Real-time Streaming**: Process millions of rows without exhausting Node-RED's RAM. Emits `msg.parts` compatible with the `join` node.
* **Mustache Templating**: Use `{{msg.myVar}}` syntax directly in the query editor.
* **Exponential Backoff & Jitter**: Built-in automatic retry mechanism for queries failing due to temporary network drops or VPN micro-cuts.
* **NTLM Support**: Connect seamlessly using Windows Active Directory accounts.

## Installation

Run the following command in your Node-RED user directory (typically `~/.node-red`):

```bash
npm install @bkmj/node-red-contrib-mssqlmj

```

## Usage

1. Add the **mssql** node to your flow.
2. Configure your database connection (Standard SQL Auth or NTLM).
3. Pass your query either via the editor, `msg.query`, or `msg.payload`.
4. (Optional) Pass an object to `msg.params` for secure parameterized queries:

```javascript
msg.query = "SELECT * FROM Users WHERE Status = @status AND Age > @age";
msg.params = {
    status: "Active",
    age: 30
};
return msg;

```

## Locales Supported

* English (`en-US`)
* Français (`fr-CA`)