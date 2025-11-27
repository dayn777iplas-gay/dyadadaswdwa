// server/js/main.js
var fs      = require('fs'),
    Metrics = require('./metrics'),
    Player  = require('./player').Player,
    Log     = require('log'),
    _       = require('underscore');

function main(config) {
    var ws          = require("./ws"),
        WorldServer = require("./worldserver"),
        server      = new ws.MultiVersionWebsocketServer(config.port),
        metrics     = config.metrics_enabled ? new Metrics(config) : null,
        worlds      = [],
        lastTotalPlayers = 0,
        log;

    // Логгер по уровню из конфига
    switch (config.debug_level) {
        case "error":
            log = new Log(Log.ERROR); break;
        case "debug":
            log = new Log(Log.DEBUG); break;
        case "info":
        default:
            log = new Log(Log.INFO); break;
    }

    // Периодически обновляем статистику онлайна
    var checkPopulationInterval = setInterval(function () {
        if (metrics && metrics.isReady) {
            metrics.getTotalPlayers(function (totalPlayers) {
                if (totalPlayers !== lastTotalPlayers) {
                    lastTotalPlayers = totalPlayers;
                    _.each(worlds, function (world) {
                        if (world && typeof world.updatePopulation === "function") {
                            world.updatePopulation(totalPlayers);
                        }
                    });
                }
            });
        }
    }, 1000);

    log.info("Starting BrowserQuest game server...");

    // ==== Подключение новых игроков ====
    server.onConnect(function (connection) {
        var world,
            connect = function () {
                if (world && typeof world.connect_callback === "function") {
                    world.connect_callback(new Player(connection, world));
                } else {
                    log.error("No world available for new connection, closing socket.");
                    try { connection.close(); } catch (e) {}
                }
            };

        if (metrics) {
            metrics.getOpenWorldCount(function (open_world_count) {
                var candidateWorlds = _.first(worlds, open_world_count || worlds.length);
                world = _.min(candidateWorlds, function (w) { return w.playerCount; });

                if (!world || typeof world.connect_callback !== "function") {
                    log.error("No suitable world found for connection (metrics mode).");
                    try { connection.close(); } catch (e) {}
                    return;
                }
                connect();
            });
        } else {
            // просто находим мир, где ещё есть место
            world = _.detect(worlds, function (w) {
                return w.playerCount < config.nb_players_per_world;
            });

            if (!world) {
                log.error(
                    "No world found in onConnect. worlds.length=" + worlds.length +
                    ", nb_players_per_world=" + config.nb_players_per_world
                );
                try { connection.close(); } catch (e) {}
                return;
            }

            if (typeof world.updatePopulation === "function") {
                world.updatePopulation();
            }
            connect();
        }
    });

    server.onError(function () {
        log.error(Array.prototype.join.call(arguments, ", "));
    });

    var onPopulationChange = function () {
        if (!metrics) return;

        metrics.updatePlayerCounters(worlds, function (totalPlayers) {
            _.each(worlds, function (world) {
                if (world && typeof world.updatePopulation === "function") {
                    world.updatePopulation(totalPlayers);
                }
            });
        });
        metrics.updateWorldDistribution(getWorldDistribution(worlds));
    };

    // ==== Создаём миры ====
    _.each(_.range(config.nb_worlds), function (i) {
        var world = new WorldServer('world' + (i + 1), config.nb_players_per_world, server);
        world.run(config.map_filepath);
        worlds.push(world);
        if (metrics) {
            world.onPlayerAdded(onPopulationChange);
            world.onPlayerRemoved(onPopulationChange);
        }
        log.info("world" + (i + 1) + " created (capacity: " + config.nb_players_per_world + " players).");
    });

    server.onRequestStatus(function () {
        return JSON.stringify(getWorldDistribution(worlds));
    });

    if (config.metrics_enabled && metrics) {
        metrics.ready(function () {
            // initialize all counters to 0 when the server starts
            onPopulationChange();
        });
    }

    process.on('uncaughtException', function (e) {
        log.error('uncaughtException: ' + e);
    });

    log.info("Server (everything) is listening on port " + config.port);
}

// ==== Вспомогательные функции ====

function getWorldDistribution(worlds) {
    var distribution = [];
    _.each(worlds, function (world) {
        distribution.push(world.playerCount);
    });
    return distribution;
}

function getConfigFile(path, callback) {
    fs.readFile(path, 'utf8', function (err, json_string) {
        if (err) {
            console.error("Could not open config file:", err.path);
            callback(null);
        } else {
            callback(JSON.parse(json_string));
        }
    });
}

var defaultConfigPath = './server/config.json',
    customConfigPath  = './server/config_local.json';

process.argv.forEach(function (val, index) {
    if (index === 2) {
        customConfigPath = val;
    }
});

getConfigFile(defaultConfigPath, function (defaultConfig) {
    getConfigFile(customConfigPath, function (localConfig) {
        if (localConfig) {
            main(localConfig);
        } else if (defaultConfig) {
            console.log("This server can be customized by creating a configuration file named: ./server/config_local.json");
            main(defaultConfig);
        } else {
            console.error("Server cannot start without any configuration file.");
            process.exit(1);
        }
    });
});
