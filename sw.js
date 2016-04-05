"use strict";

const CACHE_NAME_PREFIX = "offline";

function GetCacheBaseName()
{
	// e.g. "offline-https://example.com/"
	return CACHE_NAME_PREFIX + "-" + self.registration.scope;
};

function GetCacheVersionName(version)
{
	// e.g. "offline-https://example.com/-v2"
	return GetCacheBaseName() + "-v" + version;
};

function Wait(ms)
{
	return new Promise((resolve, reject) =>
	{
		setTimeout(resolve, ms);
	});
};

// Remove the scope from the main page URL, so e.g. "https://example.com/index.html" turns in to just "index.html".
// Note if the URL is just "https://example.com/" (i.e. the same as the scope), then leave it in its complete form,
// because looking up "/" in the cache doesn't appear to work.
function NormalizeMainPageUrl(url)
{
	if (url.indexOf(self.registration.scope) === 0)
	{
		url = url.substr(self.registration.scope.length);
		
		if (!url)
			url = self.registration.scope;
	}
	
	return url;
};

///////////////////////////////////////////////////
// install + activate events
self.addEventListener("install", function (event)
{
	console.log("[SW] Install event, scope: " + self.registration.scope + ", random number = " + Math.floor(Math.random() * 1000000));
	
	// Activate immediately.
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event)
{
	console.log("[SW] Activate event");
	
	let mainPageUrl = "";
	let jsonData = null;		// contents of offline.js
	
	// Claim all clients right away. This is necessary so we can find the URL of the main page.
	event.waitUntil(clients.claim()
	.then(GetMainPageUrl)
	.then(url =>
	{
		mainPageUrl = NormalizeMainPageUrl(url);
		
		console.log("[SW] Main page URL: " + mainPageUrl);
		
		return FetchOfflineJs();
	})
	.then(data =>
	{
		jsonData = data;
		console.log("[SW] Fetched offline.js, version = " + jsonData.version);
		
		// Add the main page URL to start of the files list (if one was detected)
		if (mainPageUrl)
			jsonData.files.unshift(mainPageUrl);
		
		console.log("[SW] Requesting " + jsonData.files.length + " files to cache...");
		
		// Request this file list and cache them
		return CacheFileList(jsonData, true);		// indicate first request
	})
	.catch (err =>
	{
		console.warn("[SW] Error activating: ", err, err.stack);
	}));
});

function GetMainPageUrl()
{
	// Assume the first client has the main page URL.
	return clients.matchAll().then(function (clientsList)
	{
		for (let c of clientsList)
		{
			console.log("[SW] Found client URL: " + c.url);
			return c.url;
		}
		
		return "";
	});
};

function FetchOfflineJs()
{
	console.log("[SW] Fetching offline.js");
	
	// Use a random query string to ensure it really makes a fresh request, and use the no-store directive
	// to skip the HTTP cache.
	return fetch("offline.js?r=" + Math.floor(Math.random() * 1000000), { cache: "no-store" })
	.then(response =>
	{
		// Ensure non-OK responses reject the promise
		if (!response.ok)
			throw new Error(response.statusText);
		
		return response.json();
	});
};

///////////////////////////////////////////////////
// Caching functions
function OpenCacheForVersion(version)
{
	let cacheName = GetCacheVersionName(version);
	console.log("[SW] Opening cache '" + cacheName + "'");
	return caches.open(cacheName);
};

function CacheFileList(jsonData, isFirstLoad)
{
	// On the first load, use a "default" cache mode. However later background update checks will use
	// "reload" to bypass the HTTP cache and ensure up-to-date resources are requested from the server.
	// This allows the first load to deduplicate in-flight requests or return already-received results,
	// but later updates always reload from the network.
	let cacheMode = (isFirstLoad ? "default" : "reload");
	
	// Map every file in the file list to a no-store fetch request and wait for them all to complete.
	let fileList = jsonData.files;
	let fetchPromises = jsonData.files.map(f => fetch(new Request(f, { cache: cacheMode, mode: "no-cors" })));
	let responseList = null;
	
	return Promise.all(fetchPromises)
	.then(result =>
	{
		responseList = result;
		
		if (responseList.length !== fileList.length)
			throw new Error("wrong number of responses");
		
		// Verify every response was OK. Throw an exception if any failed at all: we only want to cache
		// a complete set of successful responses.
		for (let r of responseList)
		{
			if (!r.ok)
				throw new Error("[SW] Failed to fetch '" + r.url + "': " + r.statusText);
		}
		
		console.log("[SW] Finished fetching files");
		
		// The specific cache to use for an entire page load is not set until the first sub-resource is requested,
		// since that is the first time a client ID is available. If we create a new cache between the main page load
		// and the first sub-resource request, the main page may end up being a different version to the rest of its
		// resources. As a terrible hack to try to reduce the chance of this, wait for 1 second to give the maximum
		// chance that a sub-resource has been requested first before we actually proceed with creating a new cache.
		return Wait(1000);
	})
	.then(() =>
	{
		console.log("[SW] Adding to cache...");
		
		// Now we have a full set of successful responses, open the cache ready to write them.
		return OpenCacheForVersion(jsonData.version);
	})
	.then(cache =>
	{
		let putPromises = [];
		
		// Write every request-response pair to the newly opened cache.
		// Note: this is probably not atomic...
		for (let i = 0, len = fileList.length; i < len; ++i)
		{
			putPromises.push(cache.put(fileList[i], responseList[i]));
		}
		
		// Wait for the writing to complete.
		return Promise.all(putPromises);
	})
	.then(() => console.log("[SW] Finished caching files, ready to work offline"));
};

function SortAscending(a, b)
{
	return a - b;
};

function FindNewestCache()
{
	return caches.keys().then(function (keyList)
	{
		let baseNameV = GetCacheBaseName() + "-v";
		
		// Filter down to only caches which start with the base name we are expecting,
		// then parse off the version number and sort them.
		let relevantCaches = keyList.filter(k => k.indexOf(baseNameV) === 0);
		let versionList = relevantCaches.map(k => parseInt(k.substr(baseNameV.length)));
		versionList.sort(SortAscending);
		
		if (!versionList.length)
			return null;		// no caches available
		
		let newestCacheName = GetCacheVersionName(versionList[versionList.length - 1]);
		console.log("[SW] Using newest cache: " + newestCacheName);
		return caches.open(newestCacheName);
	});
};

function FindNewestCacheAndDeleteOlder()
{
	let versionList = null;
	
	return caches.keys().then(function (keyList)
	{
		let baseNameV = GetCacheBaseName() + "-v";
		
		// Filter down to only caches which start with the base name we are expecting,
		// then parse off the version number and sort them.
		let relevantCaches = keyList.filter(k => k.indexOf(baseNameV) === 0);
		versionList = relevantCaches.map(k => parseInt(k.substr(baseNameV.length)));
		versionList.sort(SortAscending);
		console.log("[SW] Version list: " + versionList.join(","));
		
		// Delete all except for the newest version
		let deletePromises = [];
		
		for (let i = 0, last = versionList.length - 1; i < last; ++i)
		{
			let cacheName = GetCacheVersionName(versionList[i]);
			console.log("[SW] Deleting old cache: " + cacheName);
			deletePromises.push(caches.delete(cacheName));
		}
		
		return Promise.all(deletePromises);
	})
	.then(() =>
	{
		if (!versionList.length)
			return null;
		
		let newestCacheName = GetCacheVersionName(versionList[versionList.length - 1]);
		console.log("[SW] Using newest cache: " + newestCacheName);
		return caches.open(newestCacheName);
	});
};

///////////////////////////////////////////////////
// Fetch event code

// Map a client ID to a cache to use for the lifetime of that client. (Reloading the page creates a new client,
// so this binds a permanent cache to a single pageload.) This prevents a pageload ever requesting resources
// from different cache versions. Note we map by the client ID instead of the Client object itself, since
// clients.get() appears to return newly-constructed (and therefore different) objects every call.
let clientIdToCache = new Map();

function GetCacheForClientId(clientId)
{
	// The main navigation request sends a null id. Skip the logic below in that case, we want to wait
	// until the first request where the client ID is available.
	if (!clientId)
		return Promise.resolve(null);
	
	// If there is an existing map entry for this client, return it regardless
	// of what it is. This could return null if that was what was recorded for this client.
	if (clientIdToCache.has(clientId))
	{
		return Promise.resolve(clientIdToCache.get(clientId));
	}
	else
	{
		// Otherwise since there is no record for this client, this is the first fetch request
		// for the client where the client ID is actually available. So we want to find a cache for
		// this client to use, and record that in the clientIdToCache map so later fetches find it
		// and as a result the same cache is used for the lifetime of the client.
		return FindNewestCache()
		.then(cache =>
		{
			// Note the first few fetches all race to this point. By now another fetch could have already
			// decided which cache to use. Don't try to override this, make sure we check again if it's been set.
			if (clientIdToCache.has(clientId))
			{
				return Promise.resolve(clientIdToCache.get(clientId));
			}
			
			// Save in the map. Note 'cache' may be null here if none was found. This is OK: it means
			// all requests for this client will go to the network instead of being looked up in a cache,
			// and the fact we record null in the map means we don't keep repeating this lookup.
			console.log("[SW] Associating existing cache with client '" + clientId + "'");
			clientIdToCache.set(clientId, cache);
			return cache;		// also return this as the cache to use
		});
	}
};

function MatchRequestForClientCache(request, clientId)
{
	return GetCacheForClientId(clientId)
	.then(cache =>
	{
		// No cache available for this client: treat as not found in cache.
		if (!cache)
			return null;
		
		// Otherwise look up the request in this client's cache.
		return cache.match(request);
	});
};

// Return 'response' if it is provided, otherwise make the request.
function ReturnResponseOrFetch(request, response)
{
	if (response)
	{
		console.log("[SW] Returned '" + request.url + "' from cache");
		return response;
	}
	else
	{
		console.log("[SW] '" + request.url + "' not in cache, dispatching to network");
		return fetch(request);
	}
};

self.addEventListener("fetch", function (event)
{
	// Test if the fetched URL is within the scope of this Service Worker. Only handle in-scope URLs
	// through the offline cache. Pass through out-of-scope URLs normally.
	if (event.request.url.indexOf(self.registration.scope) === 0)
	{
		console.log("[SW] Fetch event: " + event.request.url + " (client ID '" + event.clientId + "')");
		
		if (event.request.mode === "navigate")
		{
			// Since the navigate request does not pass a client ID, we have no choice but to return the
			// main page request from any of the existing caches. Technically this could mean the main page
			// request is returned from a different version cache than the rest of the resources, but there
			// isn't anything else we can do here.
			// We also use this opportunity to clean up any older caches. They are sorted by their version
			// and all but the newest are deleted, then the newest one is returned.
			event.respondWith(FindNewestCacheAndDeleteOlder()
			.then(cache =>
			{
				if (cache)
					return cache.match(event.request);
				else
					Promise.resolve(null);
			})
			.then(response => ReturnResponseOrFetch(event.request, response)));
			
			// Kick off the update check. This runs outside of the fetch event. TODO: check if this is OK
			// Note we can tell the main page URL from the URL of this navigate event.
			CheckForUpdate(event.request.url);
		}
		else
		{
			// Look in cache first. The first request for this client ID will bind a specific cache
			// to this client ID so it will always be used for this page load.
			event.respondWith(MatchRequestForClientCache(event.request, event.clientId)
			.then(response => ReturnResponseOrFetch(event.request, response)));
		}
	}
	else
	{
		console.log("[SW] Out-of-scope fetch event for URL: " + event.request.url);
		event.respondWith(fetch(event.request));
	}
});

///////////////////////////////////////////////////
// Update check
function CheckForUpdate(mainPageUrl)
{
	mainPageUrl = NormalizeMainPageUrl(mainPageUrl);
	
	console.log("[SW] Checking for update... (main page URL = " + mainPageUrl + ")");
	
	let jsonData = null;
	
	return FetchOfflineJs()
	.then(data =>
	{
		jsonData = data;
		console.log("[SW] Fetched offline.js, version = " + jsonData.version);
		
		// Add the main page URL to start of the files list (if one was detected)
		if (mainPageUrl)
			jsonData.files.unshift(mainPageUrl);
		
		// Check if a cache of this version already exists.
		let cacheName = GetCacheVersionName(jsonData.version);
		return caches.has(cacheName);
	})
	.then(exists =>
	{
		if (exists)
		{
			// Cache already exists, so we can assume it's already fully cached and we are up-to-date.
			console.log("[SW] Up-to-date");
		}
		else
		{
			// Cache does not exist. Assume this is a new version that is available. Call CacheFileList
			// to fetch all these files and add them to a new cache. It won't be used until the next page load.
			console.log("[SW] New version available");
			return CacheFileList(jsonData, false);		// pass false to force cache-busting
		}
	})
	.catch (err =>
	{
		console.error("[SW] Error checking for update: ", err, err.stack);
	});
};
