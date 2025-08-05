const express = require("express");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

async function main() {
  // open the database file
  const db = await open({
    filename: "game.db",
    driver: sqlite3.Database,
  });

  // create 'clicks' table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT,
      click INTEGER
    );
  `);

  // create 'points' table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT,
      point REAL
    );
  `);

  // create 'users' table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT,
      userid TEXT
    );
  `);

  // create 'sync' table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count INTEGER
    );
  `);

  // clear the 'users' table
  await db.run("DELETE FROM users");

  // clear the 'clicks' table
  await db.run("DELETE FROM clicks");

  // clear the 'points' table
  await db.run("DELETE FROM points");

  // add one data to 'sync' table
  await db.run("DELETE FROM sync");
  await db.run("INSERT INTO sync (count) VALUES (0)");

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
  });

  app.use(express.static("public"));

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
  });

  let playerjoin = true;
  let points = 3;
  let syncInterval = false;

  io.on("connection", async (socket) => {
    await db.each("SELECT user FROM users", (_err, row) => {
      socket.emit("addplayer", row.user);
    });
    socket.on("addplayer", async (name) => {
      await db.each(
        "SELECT COUNT(*) AS count FROM users",
        async (_err, row) => {
          if (row.count < 10) {
            if (playerjoin) {
              await db.each(
                "SELECT COUNT(*) AS count FROM users WHERE user = ?",
                name,
                async (_err, row) => {
                  if (row.count == 0) {
                    await db.run(
                      "INSERT INTO users (user, userid) VALUES (?, ?)",
                      name,
                      socket.id
                    );
                    io.emit("addplayer", name);
                  } else {
                    socket.emit(
                      "noexec",
                      "Someone is already using that name",
                      "login"
                    );
                  }
                }
              );
            } else {
              socket.emit(
                "noexec",
                "The game already started, please wait for the next round...",
                "login"
              );
            }
          } else {
            socket.emit("noexec", "The room is full (max 10 players)", "login");
          }
        }
      );
    });
    socket.on("disconnect", async () => {
      await db.each(
        "SELECT user FROM users WHERE userid = ?",
        socket.id,
        (_err, row) => {
          io.emit("removeplayer", row.user);
        }
      );
      await db.run("DELETE FROM users WHERE userid = ?", socket.id);
      await db.each(
        "SELECT COUNT(*) AS count FROM users",
        async (_err, row) => {
          if (row.count < 2) {
            await db.run("DELETE FROM points");
            await db.run("DELETE FROM clicks");
            io.emit("endgame");
          }
        }
      );
    });
    socket.on("togglejoin", async (type) => {
      if (type == "on") {
        playerjoin = true;
      } else if (type == "off") {
        playerjoin = false;
      }
    });
    socket.on("chatmessage", async (msg) => {
      if (msg.startsWith("Point ")) {
        const pointValue = parseInt(msg.substring(6).trim());
        if (!isNaN(pointValue) && pointValue > 0) {
          points = pointValue;
          io.emit("chatmessage", `Starting points set to ${points}`, "Server");
          return;
        }
      }
      await db.each(
        "SELECT user FROM users WHERE userid = ?",
        socket.id,
        (_err, row) => {
          io.emit("chatmessage", msg, row.user);
        }
      );
    });
    socket.on("startgame", async () => {
      await db.each(
        "SELECT COUNT(*) AS count FROM users",
        async (_err, row) => {
          if (row.count < 2) {
            socket.emit(
              "noexec",
              "Not enough players... (min 2 players)",
              "start"
            );
          } else {
            //check message if there is any word "Point (num)", set points to (num)

            await db.each("SELECT user FROM users", async (_err, row) => {
              await db.run(
                "INSERT INTO points (user, point) VALUES (?, ?)",
                row.user,
                points
              );
              await db.run(
                "INSERT INTO clicks (user, click) VALUES (?, 0)",
                row.user
              );
            });
            io.emit("startgame");
            setTimeout(async () => {
              io.emit("loop");
            }, 500);
          }
        }
      );
    });
    let showstatusTimeout;
    let hidestatusTimeout;
    socket.on("loop", async () => {
      syncInterval = false;
      let breakloop = false;
      await db.each("SELECT user, point FROM points", async (_err, row) => {
        if (row.point == 0) {
          io.emit("result", row.user);
          breakloop = true;
        }
      });
      if (breakloop) return;
      socket.emit("countdown", 5);
      setTimeout(async () => {
        let clickCount = 0;
        let playerClicked = null;
        await db.each(
          "SELECT user, click FROM clicks",
          async (_err, rowCheck) => {
            if (rowCheck.click == 1) {
              clickCount++;
              playerClicked = rowCheck.user;
            }
          }
        );
        if (clickCount == 1) {
          let userCount = 0;
          await db.each(
            "SELECT COUNT(*) AS count FROM users",
            async (_err, row) => {
              userCount = row.count;
            }
          );
          setTimeout(async () => {
            let decreasePoint = 1 / userCount;
            await db.run(
              "UPDATE points SET point = point - ? WHERE user = ?",
              decreasePoint,
              playerClicked
            );
          }, 50);
        }
        showstatusTimeout = setTimeout(async () => {
          await db.each("SELECT user FROM users", async (_err, row1) => {
            await db.each(
              "SELECT click FROM clicks WHERE user = ?",
              row1.user,
              async (_err, row2) => {
                await db.each(
                  "SELECT point FROM points WHERE user = ?",
                  row1.user,
                  async (_err, row3) => {
                    socket.emit(
                      "showstatus",
                      row1.user,
                      row2.click,
                      row3.point
                    );
                  }
                );
              }
            );
          });
        }, 100);
        socket.emit("countdown", 5);
        hidestatusTimeout = setTimeout(async () => {
          await db.run("UPDATE sync SET count = count + 1");
          await db.each("SELECT count FROM sync", async (_err, row) => {
            await db.each(
              "SELECT COUNT(*) AS usercount FROM users",
              async (_err, userRow) => {
                if (row.count >= userRow.usercount) {
                  syncInterval = true;
                }
              }
            );
          });
          const interval = setInterval(async () => {
            if (syncInterval) {
              socket.emit("hidestatus");
              await db.run("UPDATE clicks SET click = 0");
              await db.run("UPDATE sync SET count = 0");
              socket.emit("loop");
              clearInterval(interval);
            }
          }, 100);
        }, 5000);
      }, 5000);
    });
    socket.on("clickbtn", async (name) => {
      await db.run("UPDATE clicks SET click = 1 WHERE user = ?", name);
    });
    socket.on("endgame", async () => {
      clearTimeout(showstatusTimeout);
      clearTimeout(hidestatusTimeout);
      await db.run("DELETE FROM points");
      await db.run("DELETE FROM clicks");
      io.emit("endgame");
    });
  });

  server.listen(3000, () => {
    console.log("server running at http://localhost:3000");
  });
}

main();
