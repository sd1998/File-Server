const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');
const mongo = require('./mongo.js');
const config = require('./config.js');
const q = require('q');
const grpc = require('grpc');
const LevelDBService = grpc.load(config.LEVEL_DB_OBJ_PROTO_PATH).LevelDBService;
const grpcClient = new LevelDBService(config.HOST_NAME + ":" + config.LEVEL_DB_GRPC_PORT, grpc.credentials.createInsecure());
const app = express()

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(cors())

const PORT = 27327 || process.env.PORT

function generatePasswordHash(password, salt) {
  var passSalt = salt
  if (passSalt == null) {
    salt = bcrypt.genSalt(config.SALT_ROUNDS).then(function(response) {
      passSalt = response
    }).fail(function(err) {
      console.error(err)
    })
  }
  return {
    passwordHashPromise: bcrypt.hash(password, passSalt),
    salt: salt
  }
}

function generateJWT(payload) {
  return jwt.sign(payload, config.PRIVATE_KEY)
}

function generateRefreshToken(id) {
  var deferred = q.defer()
  var refreshToken = generateJWT({
    userId: id,
    exp: config.REFRESH_JWT_EXP
  })
  mongo.saveRefreshToken(id, refreshToken).then(function(tokenSaved) {
    if (tokenSaved) {
      deferred.resolve({
        status: 200,
        refreshToken: refreshToken
      })
    } else {
      deferred.resolve({
        status: 400,
        message: "Unable to generate Refresh Token retry."
      })
    }
  }).fail(function(err) {
    deferred.reject(err)
  })
  return deferred.promise
}

function isValid(username, password) {
  return true
}

function getLevelDBObjet(key) {
  const deferred = q.defer()
  grpcClient.get(key, function(err, value) {
    if (err) {
      deferred.reject(err)
    }
    deferred.resolve(value)
  })
  return deferred.promise
}

function putChildLevelDB(data) {
  const deferred = q.defer()
  grpcClient.putChild({
    key: data.key,
    content: data.val
  }, function(err, val) {
    if (err) {
      deferred.reject(err)
    }
    deferred.resolve(true)
  })
  return deferred.promise
}

function delChildLevelDB(data) {
  const deferred = q.defer()
  grpcClient.delChild({
    key: data.key,
    val: data.val
  }, function(err, val) {
    if (err) {
      deferred.reject(err)
    }
    deferred.resolve(true)
  })
  return deferred.promise
}

function clearAuthTokens(userId, clearRefreshTokens) {
  var deferred = q.defer()
  getLevelDBObjet(userId).then(function(tokens) {
    delChildLevelDB(tokens).then(function(response) {
      if (clearRefreshTokens) {
        mongo.deleteManyRefreshToken(userId).then(function(response) {
          if (response) {
            deferred.resolve(true)
          } else {
            deferred.resolve(false)
          }
        }).fail(function(err) {
          deferred.reject(err)
        })
      }
    }).fail(function(err) {
      deferred.reject(err)
    })
  }).fail(function(err) {
    deferred.reject(err)
  })
  return deferred.promise
}

app.post("/signup", function(req, res) {
  if (isValid(req.body.username, req.body.password)) {
    var passwordHashObj = generatePasswordHash(req.body.password, null)
    passwordHashObj.passwordHashPromise.then(function(passwordHash) {
      mongo.insertAuthCredentials({
        username: req.body.username,
        salt: passwordHashObj.salt,
        passwordHash: passwordHash
      }).then(function(response) {
        if (response.status == 200) {
          generateRefreshToken(response.id).then(function(result) {
            if (result.status == 200) {
              const accessToken = generateJWT({
                userId: response.id,
                exp: config.JWT_EXP
              })
              putChild({
                key: response.id,
                content: [accessToken]
              }).then(function(response) {
                res.status(200).json({
                  accessToken: accessToken,
                  refreshToken: result.refreshToken,
                  tokenType: "JWT"
                })
              }).fail(function(err) {
                console.error(err)
              })
            } else {
              res.status(result.status).json({
                message: result.message
              })
            }
          }).fail(function(err) {
            console.error(err)
          })
        } else {
          res.status(response.status).json({
            message: response.message
          })
        }
      }).fail(function(err) {
        console.error(err)
      })
    }).fail(function(err) {
      console.error(err)
    })
  }
})

app.post("/login", function(req, res) {
  if (isValid(req.body.username, req.body.password)) {
    mongo.getAuthCredentials(req.body.username).then(function(response) {
      if (response.status == 200) {
        generatePassswordHash(req.body.password, response.credentials.salt).passwordHashPromise.then(function(passwordHash) {
          if (response.credentials.passwordHash == passwordHash) {
            console.log(response.credentials.id)
            generateRefreshToken(response.credentials.id).then(function(result) {
              if (result.status == 200) {
                const accessToken = generateJWT({
                  userId: response.credentials.id,
                  exp: config.JWT_EXP
                })
                putChild({
                  key: response.credentials.id,
                  content: [accessToken]
                }).then(function(response) {
                  res.status(200).json({
                    accessToken: accessToken,
                    refreshToken: result.refreshToken,
                    tokenType: "JWT"
                  })
                }).fail(function(err) {
                  consol.error(err)
                })
              } else {
                res.status(result.status).json({
                  message: result.message
                })
              }
            }).fail(function(err) {
              console.error(err)
            })
          } else {
            res.status(403).json({
              message: "Invalid credentials"
            })
          }
        }).fail(function(err) {
          console.error(err)
        })
      } else {
        res.json(response.status).json({
          message: response.message
        })
      }
    }).fail(function(err) {
      console.error(err)
    })
  }
})

app.get("/accesstoken/:token", function(req, res) {
  mongo.fetchRefreshToken(req.params.token).then(function(response) {
    if (response.status == 200) {
      jwt.verify(response.refreshToken,
        config.PRIVATE_KEY, {
          maxAge: config.REFRESH_JWT_EXP,
          clockTimestamp: new Date().getTime() / 1000
        }, function(err, payload) {
          mongo.deleteOneRefreshToken(response.refreshToken).then(function(isDeleted) {
            if (isDeleted) {
              if (err) {
                if (err.name == "TokenExpiredError") {
                  res.status(400).json({
                    message: "Refresh token expired"
                  })
                } else if (err.name == "JSONWebTokenError") {
                  res.status(400).json({
                    message: "Malformed Refresh token"
                  })
                } else {
                  res.status(400).json({
                    message: "Invalid Refresh token"
                  })
                }
              } else {
                res.status(200).json({
                  accessToken: generateJWT({
                    userId: payload.userId,
                    exp: config.JWT_EXP
                  }),
                  tokenType: "JWT"
                })
              }
            } else {
              res.status(400).json({
                message: "Invalid Refresh token"
              })
            }
          }).fail(function(err) {
            console.error(err)
          })
        })
    } else {
      res.status(response.status).json({
        message: response.message
      })
    }
  }).fail(function(err) {
    console.log(err)
  })
})

app.post("/password/change", function(req, res) {
  mongo.getAuthCredentials(req.body.userId).then(function(response) {
    if (response.status == 200) {
      generatePasswordHash(req.body.password, response.credentials.salt).passwordHashPromise.then(function(passwordHash) {
        if (response.credentials.passwordHash == passwordHash) {
          var passwordHashObj = generatePasswordHash(req.body.newPassword, null)
          passwordHashObj.passwordHashPromise.then(function(newPasswordHash) {
            mongo.updateAuthCredentials(req.body.userId, newPasswordHash, passwordHashObj.salt).then(function(response) {
              if (response.status == 200) {
                clearAuthTokens(req.body.userId, false).then(function(isSuccessful) {
                  const newAccessToken = generateJWT({
                    userId: response.credentials.id,
                    exp: config.JWT_EXP
                  })
                  putChildLevelDB({
                    key: req.body.userId,
                    content: [newAccessToken]
                  }).then(function(response) {
                    res.status(200).json({
                      message: "Password updated",
                      accessToken: newAccessToken,
                      tokenType: "JWT"
                    })
                  }).fail(function(err) {
                    console.error(err)
                  })
                }).fail(function(err) {
                  console.error(err)
                })
              } else {
                res.status(response.status).json({
                  message: response.message
                })
              }
            }).fail(function(err) {
              console.error(err)
            })
          }).fail(function(err) {
            console.error(err)
          })
        } else {
          res.status(401).json({
            message: "Incorrect password"
          })
        }
      }).fail(function(err) {
        console.error(err)
      })
    }
  }).fail(function(err) {
    console.error(err)
  })
})

app.use("*", function(req, res, next) {
  if (req.headers["authorization"] != null) {
    var authorizationHeader = req.headers["authorization"]
    var accessToken = authorizationHeader.substring(authorizationHeader.indexOf(':') + 1,
      authorizationHeader.length).trim()
    jwt.verify(accessToken,
      config.PRIVATE_KEY, {
        maxAge: config.JWT_EXP,
        clockTimestamp: new Date().getTime() / 1000
      }, function(err, payload) {
        if (err) {
          if (err.name == "TokenExpiredError") {
            res.status(400).json({
              message: "Access token expired"
            })
          } else if (err.name == "JSONWebTokenError") {
            res.status(400).json({
              message: "Malformed Access token"
            })
          }
          delChildLevelDB(payload.userId, accessToken).then(function(isSuccessful) {
            if (isSuccessful) {
              console.log("Access token deleted from LevelDB")
            }
          }).fail(function(err) {
            console.error(err)
          })
        }
        req.accessToken = jwt.decode(accessToken, { complete: true })
        next()
      })
  } else {
    res.json(401).json({
      "message": "Unauthorized"
    })
  }
})

app.post("/logout", function(req, res) {
  delChildLevelDB(req.body.userId, [req.accessToken]).then(function(isSuccessful) {
    if (isSuccessful) {
      res.status(200).json({
        message: "Logout successful"
      })
    }
  }).fail(function(err) {
    console.error(err)
  })
})

//Add support for 2FA using TOTP here

app.listen(PORT, function() {
  console.log("Listening to port:- " + PORT);
})