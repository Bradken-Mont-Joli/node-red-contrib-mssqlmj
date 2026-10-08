const { Connection } = require('tedious');
const { Pool } = require('tarn');

module.exports = function(RED) {
    function MSSQLMJConfigNode(n) {
        RED.nodes.createNode(this, n);

        this.server = n.server;
        this.port = parseInt(n.port, 10) || 1433;
        this.database = n.database;
        this.domain = n.domain;
        this.encrypt = n.encrypt || false;
        this.trustServerCertificate = n.trustServerCertificate !== undefined ? n.trustServerCertificate : true;
        this.authType = n.authType || 'ntlm';

        this.minPool = parseInt(n.minPool, 10) || 2;
        this.maxPool = parseInt(n.maxPool, 10) || 10;
        this.prewarmPool = n.prewarmPool !== undefined ? n.prewarmPool : true;
        this.connectTimeout = parseInt(n.connectTimeout, 10) || 15000;
        this.requestTimeout = parseInt(n.requestTimeout, 10) || 30000;
        this.retryAttempts = parseInt(n.retryAttempts, 10) || 3;
        this.retryDelay = parseInt(n.retryDelay, 10) || 500;

        this.username = this.credentials ? this.credentials.username : "";
        this.password = this.credentials ? this.credentials.password : "";

        const node = this;

        node.pool = new Pool({
            create: (cb) => {
                const actualAuthType = (node.authType === 'ntlm-windows-authentication' || node.authType === 'ntlm') ? 'ntlm' : 'default';

                const config = {
                    server: node.server,
                    authentication: {
                        type: actualAuthType,
                        options: {
                            userName: node.username,
                            password: node.password
                        }
                    },
                    options: {
                        port: node.port,
                        database: node.database,
                        encrypt: node.encrypt,
                        trustServerCertificate: node.trustServerCertificate,
                        tdsVersion: '7_4',
                        rowCollectionOnRequestCompletion: false,
                        connectTimeout: node.connectTimeout,
                        requestTimeout: node.requestTimeout
                        // 'useColumnNames: true' retiré pour garantir la réception d'un tableau 'columns'
                    }
                };

                if (actualAuthType === 'ntlm' && node.domain) {
                    config.authentication.options.domain = node.domain;
                }

                const conn = new Connection(config);

                conn.on('connect', (err) => {
                    if (err) return cb(err);
                    cb(null, conn);
                });

                conn.on('error', (err) => {
                    node.warn("Erreur sur socket pool : " + err.message);
                });

                conn.connect();
            },
            validate: (conn) => {
                return conn && conn.state && conn.state.name === 'LoggedIn';
            },
            destroy: (conn) => {
                return new Promise((resolve) => {
                    conn.on('end', resolve);
                    try { conn.close(); } catch(e) { resolve(); }
                });
            },
            min: node.minPool,
            max: node.maxPool,
            idleTimeoutMillis: 30000,
            acquireTimeoutMillis: node.connectTimeout
        });

        node.acquire = async function() {
            return await node.pool.acquire().promise;
        };

        node.release = function(conn) {
            if (conn) node.pool.release(conn);
        };

        // Pré-chauffage des connexions au démarrage du flow
        if (node.prewarmPool && node.minPool > 0) {
            setImmediate(async () => {
                node.log(`Pré-chauffage du pool (${node.minPool} connexions)...`);
                const conns = [];
                for (let i = 0; i < node.minPool; i++) {
                    try {
                        const conn = await node.acquire();
                        conns.push(conn);
                    } catch (e) {
                        node.warn("Échec pré-chauffage connexion : " + e.message);
                    }
                }
                conns.forEach(c => node.release(c));
                if (conns.length > 0) {
                    node.log(`Pool pré-chauffé avec succès (${conns.length}/${node.minPool} connexions prêtes).`);
                }
            });
        }

        node.on('close', async function(done) {
            try {
                await node.pool.destroy();
            } catch(e) {}
            done();
        });
    }

    RED.nodes.registerType("mssqlmj-config", MSSQLMJConfigNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};