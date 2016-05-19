/*******************************************************************************
 * Copyright (c) 2012, 2013 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/
/*eslint-env node*/
var auth = require('./lib/middleware/auth'),
	express = require('express'),
	http = require('http'),
	https = require('https'),
	fs = require('fs'),
	compression = require('compression'),
    path = require('path'),
    socketio = require('socket.io'),
    util = require('util'),
    argslib = require('./lib/args'),
    ttyShell = require('./lib/tty_shell'),
    orion = require('./index.js');

// Get the arguments, the workspace directory, and the password file (if configured), then launch the server
var args = argslib.parseArgs(process.argv);

var PORT_LOW = 8082;
var PORT_HIGH = 10082;
var port = args.port || args.p || process.env.PORT || 8081;
var configFile = args.config || args.c || path.join(__dirname, 'orion.conf');

var configParams = argslib.readConfigFileSync(configFile) || {};

function startServer(cb) {
	
	var workspaceArg = args.workspace || args.w;
	var workspaceConfigParam = configParams.workspace;
	var workspaceDir;
	if (workspaceArg) {
		// -workspace passed in command line is relative to cwd
		workspaceDir = path.resolve(process.cwd(), workspaceArg);
	} else if (workspaceConfigParam) {
		 // workspace param in orion.conf is relative to the server install dir.
		workspaceDir = path.resolve(__dirname, workspaceConfigParam);
	} else {
		workspaceDir = path.join(__dirname, '.workspace');
	}

	argslib.createDirs([workspaceDir], function() {
		var passwordFile = args.password || args.pwd;
		argslib.readPasswordFile(passwordFile, function(password) {
			var dev = Object.prototype.hasOwnProperty.call(args, 'dev');
			var log = Object.prototype.hasOwnProperty.call(args, 'log');
			if (dev) {
				console.log('Development mode: client code will not be cached.');
			}
			if (passwordFile) {
				console.log(util.format('Using password from file: %s', passwordFile));
			}
			console.log(util.format('Using workspace: %s', workspaceDir));
			
			var server;
			try {
				// create web server
				var orionMiddleware = orion({
					workspaceDir: workspaceDir,
					configParams: configParams,
					maxAge: dev ? 0 : undefined,
				});
				
				// add socketIO and app support
				var app = express();
				if (configParams["orion.https.key"] && configParams["orion.https.cert"]) {
					server = https.createServer({
						key: fs.readFileSync(configParams["orion.https.key"]),
						cert: fs.readFileSync(configParams["orion.https.cert"])
					}, app);
				}
				else {
					server = http.createServer(app);
				}

				if (log) {
					app.use(express.logger('tiny'));
				}
				if (password || configParams.pwd) {
					app.use(auth(password || configParams.pwd));
				}
				app.use(compression());
				app.use(orionMiddleware);
				function portFound() {
					console.log(util.format('Listening on port %d...', port));
				}

				function getPort() {
					return Math.floor(Math.random() * (PORT_HIGH - PORT_LOW) + PORT_LOW);
				}

				server.listen(port, portFound);
				
				
				var io = socketio.listen(server, { 'log level': 1 });
				ttyShell.install({ io: io, fileRoot: '/file', workspaceDir: workspaceDir });
				if (cb) {
					cb();
				}
			} catch (e) {
				console.error(e && e.stack);
			}
			server.on('error', function(err) {
				if (err.code === "EADDRINUSE") {
					server.listen(getPort(), portFound);
				}
			});
		});
	});
}

if (process.versions.electron) {
	var electron = require('electron'),
		autoUpdater = require('auto-updater'),
		spawn = require('child_process').spawn,
		os = require('os');

	var mainWindow = null;

	var handleSquirrelEvent = function() {
		if (process.argv.length === 1 || os.platform() !== 'win32') { // No squirrel events to handle
			return false;
		}

		var	target = path.basename(process.execPath);

		function executeSquirrelCommand(args, done) {
  		 	var updateDotExe = path.resolve(path.dirname(process.execPath), 
		      	'..', 'Update.exe');
		    var child = spawn(updateDotExe, args, { detached: true });
		    child.on('close', function(code) {
		    	done();
		    });
		};

		var squirrelEvent = process.argv[1];
	   	switch (squirrelEvent) {
	   		case '--squirrel-install':
	      	case '--squirrel-updated':
	      		// Install desktop and start menu shortcuts
	      		executeSquirrelCommand(["--createShortcut", target], electron.app.quit);
	      		setTimeout(electron.app.quit, 1000);
	      		return true;
	      	case '--squirrel-obsolete':
	      		// This is called on the outgoing version of the app before
	      		// we update to the new version - it's the opposite of
	      	  	// --squirrel-updated
	      		electron.app.quit();
	      		return true;
	      	case '--squirrel-uninstall':
	      		// Remove desktop and start menu shortcuts
	      		executeSquirrelCommand(["--removeShortcut", target], electron.app.quit);
	      		setTimeout(electron.app.quit, 1000);
	      		return true;
	    }
	    return false;
	};

	if (handleSquirrelEvent()) {
		// Squirrel event handled and app will exit in 1000ms
		return;
	}

	electron.app.on('ready', function() {
		function createWindow(url){
			var nextWindow = new electron.BrowserWindow({width: 1024, height: 800, title: "Orion", icon: "icon/256x256/orion.png"});
			nextWindow.loadURL("file:///" + __dirname + "/lib/main.html#" + encodeURI(url));
			nextWindow.webContents.on("new-window", /* @callback */ function(event, url, frameName, disposition, options){
				event.preventDefault();
				if (false === undefined) {// Always open new tabs for now
					createWindow(url);
				} else {
					nextWindow.webContents.executeJavaScript("__openFolder = require('dialog').showSaveDialog;");
					nextWindow.webContents.executeJavaScript('createTab("' + url + '");');
				}
			});
			return nextWindow;
		}
		startServer(function() {
			mainWindow = createWindow("http://localhost:" + port);
			mainWindow.on('closed', function() {
				mainWindow = null;
			});
		});

	});

	electron.app.on('window-all-closed', function() {
		electron.app.quit();	
	});

	// autoUpdater event listeners
	autoUpdater.on('error', function (event, message) {
	  	//console.log('auto-updater error', message);
	});
	autoUpdater.on('checking-for-update', function() {
	  	//console.log('auto-updater checking for update');
	});
	autoUpdater.on('update-available', function () {
		//console.log('auto-updater update available');
	});
	autoUpdater.on('update-not-available', function() {
	  	//console.log('auto-updater update not available');
	});
	autoUpdater.on('update-downloaded', function() {
	  	//console.log('auto-updater update downloaded');
	});

	var platform = os.platform() + '_' + os.arch(),
		version = electron.app.getVersion();
	// console.log('Platform: ' + platform + ' ' + version);
	
	// Check for updates every time we run the electron app
	autoUpdater.setFeedURL('http://orion-update.mybluemix.net/update/'+ platform + '/' + version);
	autoUpdater.checkForUpdates();

} else {
	startServer();
}
