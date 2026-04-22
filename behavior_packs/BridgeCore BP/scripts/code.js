import { world, system, Player, CustomCommandStatus, CommandPermissionLevel } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";

const trackerBlockType = "test:tracker"; // update if needed
const detectorBlockType = "test:detector"; // update if needed
const voidLevel = 30; // update if needed

const totalBlocks = new Map();
const rightClicks = new Map();
const playerTickingAreas = new Map(); // Maps player name -> tickingArea name
let worldOwnerName = null;

// Function to get the next available ticking area name (tickingArea1 to tickingArea10)
function getAvailableTickingAreaName() {
    const dim = world.getDimension("overworld");
    const usedNames = new Set(playerTickingAreas.values());
    
    for (let i = 1; i <= 10; i++) {
        const name = `tickingArea${i}`;
        if (!usedNames.has(name)) {
            return name;
        }
    }
    
    // If all are taken, reuse tickingArea1 (delete old one first)
    return "tickingArea1";
}

// Function to create a circular ticking area with radius 4 at a given position
function createTickingArea(position, playerName) {
    try {
        const dim = world.getDimension("overworld");
        
        // Get available name
        const areaName = getAvailableTickingAreaName();
        
        // Delete the old ticking area if it exists (to avoid duplicates)
        try {
            dim.runCommand(`tickingarea remove "${areaName}"`);
        } catch (err) {
            // Area doesn't exist, that's fine
        }
        
        // Create circular ticking area with radius 4
        const radius = 4;
        system.runTimeout(() => {
        dim.runCommand(`tickingarea add circle ${Math.floor(position.x)} ${Math.floor(position.y)} ${Math.floor(position.z)} ${radius} "${areaName}"`);
        
        // Track which player created this ticking area
        playerTickingAreas.set(playerName, areaName);
        }, 30); // delay to ensure player has fully teleported before creating ticking area
        
        return areaName;
    } catch (err) {
        console.warn(`Failed to create ticking area at ${position}:`, err);
        return null;
    }
}

// Function to delete a specific player's ticking area
function deletePlayerTickingArea(playerName) {
    try {
        system.runTimeout(() => {
            const areaName = playerTickingAreas.get(playerName);
            if (areaName) {
                const dim = world.getDimension("overworld");
                try {
                    dim.runCommand(`tickingarea remove "${areaName}"`);
                } catch (err) {
                    // Area might not exist
                }
                playerTickingAreas.delete(playerName);
            }
        }, 30); // delay to ensure any pending operations related to the ticking area are completed before deletion
    } catch (err) {
        console.warn(`Failed to delete ticking area for ${playerName}:`, err);
    }
}

// Function to delete all ticking areas
function deleteAllTickingAreas() {
    try {
        system.runTimeout(() => {
            const dim = world.getDimension("overworld");
            for (let i = 1; i <= 10; i++) {
                try {
                    dim.runCommand(`tickingarea remove "tickingArea${i}"`);
                } catch (err) {
                    // Area doesn't exist, continue
                }
            }
            playerTickingAreas.clear();
        }, 30); // delay to ensure any pending operations related to the ticking areas are completed before deletion
    } catch (err) {
        console.warn("Failed to delete ticking areas:", err);
    }
}

// Function to count players in a specific speedbridge mode variant
function countPlayersInSpeedBridgeMode(modeVariant) {
    const players = world.getPlayers();
    return players.filter(p => p.hasTag(`speedbridge_${modeVariant}`)).length;
}

// Helper function to get the current game mode and variant for block placement tracking
function getCurrentModeForBlockTracking(player) {
    // Check if in freestyle mode
    if (player.hasTag('freestyle')) {
        if (player.hasTag('noScore')) {
            return { mode: 'freestyle', variant: 'noScore' };
        }
        if (player.hasTag('oneblock')) {
            return { mode: 'freestyle', variant: 'oneBlock' };
        }
        if (player.hasTag('customisland')) {
            return { mode: 'freestyle', variant: 'customIsland' };
        }
        if (player.hasTag('patternlearning')) {
            return { mode: 'freestyle', variant: 'patternLearning' };
        }
        return { mode: 'freestyle', variant: 'default' };
    }
    
    // Check if in a run mode
    const runMode = getModeAndVariant(player);
    if (runMode) {
        return { mode: runMode.mode, variant: runMode.variant };
    }
    
    return null;
}

// Helper function to build the dynamic property key
function getPlacedBlocksPropKey(mode, variant) {
    return `placedBlocks_${mode}_${variant}`;
}

function getPlayerPlacedBlocks(player) {
    if (player.hasTag('buildmode') || player.hasTag('admin')) return [];
    try {
        const modeInfo = getCurrentModeForBlockTracking(player);
        if (!modeInfo) return [];
        
        const propKey = getPlacedBlocksPropKey(modeInfo.mode, modeInfo.variant);
        const placedBlocksStr = player.getDynamicProperty?.(propKey);
        if (typeof placedBlocksStr === 'string') {
            return JSON.parse(placedBlocksStr);
        }
        return [];
    } catch (err) {
        return [];
    }
}

function setPlayerPlacedBlocks(player, arr) {
    if (player.hasTag('buildmode') || player.hasTag('admin')) return;
    try {
        const modeInfo = getCurrentModeForBlockTracking(player);
        if (!modeInfo) return;
        
        const propKey = getPlacedBlocksPropKey(modeInfo.mode, modeInfo.variant);
        const jsonStr = JSON.stringify(Array.isArray(arr) ? arr : []);
        player.setDynamicProperty?.(propKey, jsonStr);
    } catch (err) {
        console.warn(`Failed to save placed blocks for ${player.name}:`, err);
    }
}

function addPlacedBlockForPlayer(player, blockLocation, blockType) {
    if (player.hasTag('buildmode') || player.hasTag('admin')) return;
    const list = getPlayerPlacedBlocks(player);
    list.push({
        x: Math.floor(blockLocation.x),
        y: Math.floor(blockLocation.y),
        z: Math.floor(blockLocation.z),
        type: blockType,
        ts: Date.now()
    });
    setPlayerPlacedBlocks(player, list);
}

function clearPlacedBlocksForPlayer(player) {
    if (player.hasTag('buildmode') || player.hasTag('admin')) return;
    const list = getPlayerPlacedBlocks(player);
    if (!Array.isArray(list) || list.length === 0) {
        return;
    }
    system.runTimeout(() => {
        for (const loc of list) {
            try {
                player.runCommand(`setblock ${Math.floor(loc.x)} ${Math.floor(loc.y)} ${Math.floor(loc.z)} air`);
            } catch (err) {
                // ignore failures
            }
        }
        setPlayerPlacedBlocks(player, []);
    }, 5);
}

const runState = new Map();
function getStateFor(player) {
    const key = player.name;
    if (!runState.has(key)) runState.set(key, {
        active: false,
        startTime: null,
        timerId: null,
        gmc: false,
        flymode: false,
        bestTimes: {
            speedbridge: {},  // {short: X, normal: Y, long: Z, ...}
            parkour: {},      // {pcourse1: X, pcourse2: Y, ...}
            gauntlet: {},     // {gcourse1: X, gcourse2: Y, ...}
            bedwarsRush: {}   // {city: X, paradise: Y, ...}
        },
    });
    return runState.get(key);
}

// Helper function to get the mode and variant from player tags
function getModeAndVariant(player) {
    const speedbridgeModes = ['short', 'normal', 'long', 'stackUp', 'shortDiagonal', 'diagonal'];
    const speedbridgeIslands = ['no1', 'no2', 'no3', 'no4', 'no5'];
    const parkourCourses = Array.from({ length: 10 }, (_, i) => `pcourse${i + 1}`);
    const gauntletCourses = Array.from({ length: 10 }, (_, i) => `gcourse${i + 1}`);
    const bedwarsRushMaps = ['city', 'paradise', 'citadel', 'luck', 'village', 'wasteland', 'nether', 'temple'];
    
    // Check speedbridge - look for the mode and island tags
    if (player.hasTag('speedbridge')) {
        for (const mode of speedbridgeModes) {
            if (player.hasTag(`speedbridge_${mode}`)) {
                // Find which island they're on
                for (const island of speedbridgeIslands) {
                    if (player.hasTag(`speedbridge_${mode}_${island}`)) {
                        const coordData = coords.speedbridge[mode][island];
                        return { mode: 'speedbridge', variant: mode, island: island, pos: coordData.pos, facing: coordData.facing };
                    }
                }
            }
        }
    }
    
    // Check parkour
    for (const course of parkourCourses) {
        if (player.hasTag(course)) {
            const coordData = coords.parkour[course];
            return { mode: 'parkour', variant: course, pos: coordData.pos, facing: coordData.facing };
        }
    }
    
    // Check gauntlet
    for (const course of gauntletCourses) {
        if (player.hasTag(course)) {
            const coordData = coords.gauntlet[course];
            return { mode: 'gauntlet', variant: course, pos: coordData.pos, facing: coordData.facing };
        }
    }
    
    // Check bedwars rush
    for (const map of bedwarsRushMaps) {
        if (player.hasTag(`bedwarsrush_${map}`)) {
            const coordData = coords.rush[map];
            return { mode: 'bedwarsRush', variant: map, pos: coordData.pos, facing: coordData.facing };
        }
    }
    
    return null;
}

function getPlayerBestTimes(player) {
    const state = getStateFor(player);
    
    // Try to load from dynamic properties
    try {
        const bestTimesStr = player.getDynamicProperty?.('bestTimes');
        if (bestTimesStr && typeof bestTimesStr === 'string') {
            const parsed = JSON.parse(bestTimesStr);
            state.bestTimes = parsed;
            return parsed;
        }
    } catch (err) {
        // If parsing fails, continue with in-memory state
    }
    
    return state.bestTimes;
}

function setPlayerBestTimes(player, bestTimes) {
    const state = getStateFor(player);
    state.bestTimes = bestTimes;
    
    // Save to dynamic properties for persistence
    try {
        player.setDynamicProperty?.('bestTimes', JSON.stringify(bestTimes));
    } catch (err) {
        console.warn(`Failed to save best times for ${player.name}:`, err);
    }
}

function saveBestTime(player, mode, variant, time) {
    const state = getStateFor(player);
    if (!state.bestTimes[mode]) {
        state.bestTimes[mode] = {};
    }
    state.bestTimes[mode][variant] = time;
    setPlayerBestTimes(player, state.bestTimes);
}

function startRun(player) {
    const s = getStateFor(player);
    if (s.active) return;
    s.startTime = Date.now();
    s.active = true;
    player.playSound("random.click");
    player.runCommand('clear @s orange_dye');
    player.runCommand('clear @s yellow_dye');
    // per-player actionbar updater
    s.timerId = system.runInterval(() => {
        // update actionbar with elapsed
        const elapsed = ((Date.now() - s.startTime) / 1000).toFixed(2);
        player.onScreenDisplay.setActionBar(`§bTime: §r${elapsed}`); // show elapsed time in seconds with 2 decimal places
    });
}

function stopRun(player) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    player.runCommand('clear @s');
    const s = getStateFor(player);
    if (!s.active) return;
    // stop timer
    if (s.timerId) {
        player.removeTag('run');
        system.clearRun(s.timerId);
        s.timerId = null;
    }
    const elapsedMs = Date.now() - (s.startTime || Date.now());
    const elapsed = (elapsedMs / 1000);
    const displayElapsed = elapsed.toFixed(2);
    const compareElapsed = parseFloat(elapsed.toFixed(3));
    system.runTimeout(() => {
        player.onScreenDisplay.setActionBar(`§bFinal Time: §r${displayElapsed}`);
    }, 1);
    // Get mode and variant
    const modeInfo = getModeAndVariant(player);
    if (!modeInfo) {
        // Not in any tracked mode
        s.startTime = null;
        s.active = false;
        return;
    }

    const { mode, variant } = modeInfo;
    const bestTimeForVariant = s.bestTimes[mode][variant];

    // best time check - compare with existing best time for this variant
    // For gauntlet, only save best time if accuracy is 100%
    let shouldSaveTime = false;
    let gauntletAccuracy = null;
    
    if (mode === 'gauntlet') {
        gauntletAccuracy = calculateGauntletAccuracy(player, variant);
        if (gauntletAccuracy && gauntletAccuracy.percentage === 100) {
            shouldSaveTime = bestTimeForVariant === undefined || compareElapsed < bestTimeForVariant;
        }
    } else {
        shouldSaveTime = bestTimeForVariant === undefined || compareElapsed < bestTimeForVariant;
    }
    
    if (shouldSaveTime) {
        saveBestTime(player, mode, variant, compareElapsed);
        player.playSound("random.levelup");
        player.onScreenDisplay.setTitle(`§bTime: §r${displayElapsed}`);
        player.runCommand(`title @s subtitle §aNew Record!`);
        player.sendMessage('§8-------------------------------');
        player.sendMessage(`§bRecord Date: §r${dateStr}`);
        player.sendMessage(`§bMode: §r${mode} - ${variant}`);
        player.sendMessage(`§bNew Record: §r${displayElapsed} §7(${(compareElapsed)})`);
        
        // Add gauntlet accuracy if in gauntlet mode
        if (mode === 'gauntlet' && gauntletAccuracy !== null) {
            player.sendMessage(`§bAccuracy: §r${gauntletAccuracy.percentage.toFixed(0)} §7(${gauntletAccuracy.blocksOnTracker}/${gauntletAccuracy.totalTrackerBlocks})`);
        }
        player.playSound('random.screenshot');
        player.spawnParticle('minecraft:knockback_roar_particle', player.getHeadLocation());
        player.playSound('firework.blast');    
    } else {
        player.playSound("random.orb");
        player.sendMessage('§8-------------------------------');
        player.onScreenDisplay.setTitle(`§bTime: §r${displayElapsed}`);
        player.sendMessage(`§bMode: §r${mode} - ${variant}`);
        
        if (mode === 'gauntlet' && gauntletAccuracy !== null && gauntletAccuracy.percentage < 100) {
            player.sendMessage(`§bTime: §r${displayElapsed}`);
            player.sendMessage(`§cAccuracy: §r${gauntletAccuracy.percentage.toFixed(0)} §7(${gauntletAccuracy.blocksOnTracker}/${gauntletAccuracy.totalTrackerBlocks})`);
            player.sendMessage(`§cNeed §r100% Accuracy §cfor saving Best Time!`);
        } else {
            player.sendMessage(`§bTime: §r${displayElapsed}`);        
            if (bestTimeForVariant) {
                player.sendMessage(`§bBest Time: §r${(bestTimeForVariant).toFixed(2)} §7(${(bestTimeForVariant).toFixed(3)})`);
            }
            
            // Add gauntlet accuracy if in gauntlet mode
            if (mode === 'gauntlet' && gauntletAccuracy !== null) {
                player.sendMessage(`§bAccuracy: §r${gauntletAccuracy.percentage.toFixed(0)} §7(${gauntletAccuracy.blocksOnTracker}/${gauntletAccuracy.totalTrackerBlocks})`);
            }
        }
    }
    player.sendMessage('§8-------------------------------');
    s.startTime = null;
    s.active = false;
    
    // teleport back to the run spawn / re-equip items
    try {
        if (modeInfo) {
            player.runCommand('clear @s');
            system.runTimeout(() => {
                clearPlacedBlocksForPlayer(player);
                player.addTag('run');
                giveItem(player);
                player.teleport(modeInfo.pos, { facingLocation: modeInfo.facing });
                if (mode === 'gauntlet') {
                    replaceTracker(player);
                }
            }, 60);
        }
    } catch (e) { /* ignore if coords not available */ }
}

function replaceTracker(player) {
    const modeInfo = getModeAndVariant(player);
    if (modeInfo && modeInfo.mode === 'gauntlet') {
        const { variant } = modeInfo;
        const trackerBlocks = coords.gauntlet[variant]?.tracker;
        
        if (trackerBlocks && Array.isArray(trackerBlocks) && trackerBlocks.length > 0) {
            for (const tracker of trackerBlocks) {
                system.runTimeout(() => {
                    player.runCommand(`setblock ${tracker.x} ${tracker.y} ${tracker.z} test:tracker`);
                }, 5);
            }
            system.runTimeout(() => {
                player.onScreenDisplay.setActionBar(`§aTracker Replaced!`);
            }, 10);
        }
    }
}

// Helper function to calculate gauntlet accuracy
function calculateGauntletAccuracy(player, gauntletVariant) {
    try {
        const placedBlocks = getPlayerPlacedBlocks(player);
        const trackerBlocks = coords.gauntlet[gauntletVariant].tracker;
        
        if (!trackerBlocks || trackerBlocks.length === 0) {
            return null;
        }
        
        if (!placedBlocks || placedBlocks.length === 0) {
            return {
                percentage: 0,
                blocksOnTracker: 0,
                totalTrackerBlocks: trackerBlocks.length
            };
        }
        
        // Create a set of tracker block positions for quick lookup
        const trackerSet = new Set();
        for (const tracker of trackerBlocks) {
            trackerSet.add(`${tracker.x},${tracker.y},${tracker.z}`);
        }
        
        // Count how many placed blocks match tracker positions
        let blocksOnTracker = 0;
        for (const block of placedBlocks) {
            const key = `${block.x},${block.y},${block.z}`;
            if (trackerSet.has(key)) {
                blocksOnTracker++;
            }
        }
        
        // Calculate accuracy as percentage
        const percentage = (blocksOnTracker / trackerBlocks.length) * 100;
        return {
            percentage: percentage,
            blocksOnTracker: blocksOnTracker,
            totalTrackerBlocks: trackerBlocks.length
        };
    } catch (e) {
        return null;
    }
}

// New function to reset ALL best times
function resetAllBestTimes(player) {
    const s = getStateFor(player);
    s.bestTimes = {
        speedbridge: {},
        parkour: {},
        gauntlet: {},
        bedwarsRush: {}
    };
    setPlayerBestTimes(player, s.bestTimes);
    world.sendMessage(`§c§l${player.name}§c's Best times have been reset!`);
}

function respawnRun(player) {
    const s = getStateFor(player);
    
    // Calculate elapsed time before resetting
    let displayElapsed = "0.00";
    if (s.active && s.startTime) {
        const elapsedMs = Date.now() - s.startTime;
        const elapsed = (elapsedMs / 1000);
        displayElapsed = elapsed.toFixed(2);
    }
    
    if (s.timerId) {
        system.clearRun(s.timerId);
        s.timerId = null;
    }
    s.active = false;
    s.startTime = null;
    player.playSound("random.click");
    player.runCommand('clear @s');
    
    try {
        const modeInfo = getModeAndVariant(player);
        if (modeInfo) {
            if (modeInfo) {
                player.runCommand('clear @s');
                clearPlacedBlocksForPlayer(player);
                player.addTag('run');
                giveItem(player);
                player.teleport(modeInfo.pos, { facingLocation: modeInfo.facing });
                system.runTimeout(() => {
                    player.onScreenDisplay.setActionBar(`§cTime: §r${displayElapsed}`); // show elapsed time instead of reset message
                }, 1);
                if (modeInfo.mode === 'gauntlet') {
                    replaceTracker(player);
                }
            }
        }
    } catch (e) {
        /* ignore if coords not available */
    }
}

function giveItem(player) {
    player.runCommand('clear @s');
    // Get saved primary block, or default to sandstone
    let blockToGive = 'sandstone';
    try {
        const savedBlock = player.getDynamicProperty?.('primaryBlock');
        if (savedBlock && typeof savedBlock === 'string') {
            blockToGive = savedBlock;
        }
    } catch (e) {
        // fallback to sandstone
    }
    
    // Try to give the block, fallback to sandstone if it fails
    try {
        if (player.hasTag('speedbridge') || player.hasTag('bedwarsrush') || player.hasTag('parkour') || player.hasTag('gauntlet')) {
            player.runCommand(`give @s ${blockToGive} 64`);
            player.runCommand('replaceitem entity @s slot.hotbar 7 orange_dye 1');
            player.runCommand('replaceitem entity @s slot.hotbar 8 yellow_dye 1');
        } else if (player.hasTag('freestyle')) {
            player.runCommand(`give @s ${blockToGive} 64`);
            player.runCommand('replaceitem entity @s slot.hotbar 6 orange_dye 1');
            player.runCommand('replaceitem entity @s slot.hotbar 7 yellow_dye 1');
            player.runCommand('replaceitem entity @s slot.hotbar 8 red_dye 1');
            if (player.hasTag('patternlearning')) {
                player.runCommand('replaceitem entity @s slot.hotbar 5 pink_dye 1');
            }
        }
    } catch (e) {
        // If giving the primaryBlock fails, try again with sandstone
        blockToGive = 'sandstone';
        try {
            if (player.hasTag('speedbridge') || player.hasTag('bedwarsrush') || player.hasTag('parkour') || player.hasTag('gauntlet')) {
                player.runCommand(`give @s ${blockToGive} 64`);
                player.runCommand('replaceitem entity @s slot.hotbar 7 orange_dye 1');
                player.runCommand('replaceitem entity @s slot.hotbar 8 yellow_dye 1');
            } else if (player.hasTag('freestyle')) {
                player.runCommand(`give @s ${blockToGive} 64`);
                player.runCommand('replaceitem entity @s slot.hotbar 6 orange_dye 1');
                player.runCommand('replaceitem entity @s slot.hotbar 7 yellow_dye 1');
                player.runCommand('replaceitem entity @s slot.hotbar 8 red_dye 1');
                if (player.hasTag('patternlearning')) {
                    player.runCommand('replaceitem entity @s slot.hotbar 5 pink_dye 1');
                }
            }
        } catch (fallbackErr) {
            console.warn(`Failed to give items to ${player.name}:`, fallbackErr);
        }
    }
}

function getPlayerItemCount(player, itemId) {
    try {
        const invComp = player.getComponent("minecraft:inventory");
        if (!invComp || !invComp.container) return 0;
        const container = invComp.container;
        let total = 0;
        for (let i = 0; i < container.size; i++) {
            const it = container.getItem(i);
            if (!it) continue;
            if (it.typeId === itemId) total += it.amount || 0;
        }
        return total;
    } catch (e) {
        return 0;
    }
}

function getPlayerRightCPS(player) {
    const currentTime = Date.now();
    const playerClicks = rightClicks.get(player) || [];
    const recentClicks = playerClicks.filter(({ timestamp }) => currentTime - 1000 < timestamp);
    rightClicks.set(player, recentClicks);
    return recentClicks.length;
}

// Helper function to get player's primary building block type (with persistence)
function getPlayerPrimaryBlockType(player) {
    try {
        const savedBlock = player.getDynamicProperty?.('primaryBlock');
        if (savedBlock && typeof savedBlock === 'string') {
            const blockCount = getPlayerItemCount(player, savedBlock);
            if (blockCount > 0) {
                return savedBlock;
            }
        }
        return null; // Return null if saved block doesn't exist
    } catch (e) {
        return null;
    }
}

// Helper function to save player's block preference
function setPlayerPrimaryBlock(player, blockType) {
    try {
        player.setDynamicProperty?.('primaryBlock', blockType);
    } catch (err) {
        console.warn(`Failed to save primary block for ${player.name}:`, err);
    }
}

const BLOCK_CHECK_OFFSETS = [1, 2, 3];
const FINISHER_BLOCK = "test:finisher";
const COAL_BLOCK = "minecraft:coal_block";

// Helper function to get blocks at multiple heights below player
function getBlocksBelow(player, offsets) {
    const baseX = Math.floor(player.location.x);
    const baseY = Math.floor(player.location.y);
    const baseZ = Math.floor(player.location.z);
    
    return offsets.map(offset => 
        world.getDimension("overworld").getBlock({
            x: baseX,
            y: baseY - offset,
            z: baseZ
        })
    );
}

//everything runinterval
system.runInterval(() => {
    for (const player of world.getPlayers()) {
        const rCPS = getPlayerRightCPS(player);
        const primaryBlockType = getPlayerPrimaryBlockType(player);
        if (primaryBlockType) {
            const blockCount = getPlayerItemCount(player, primaryBlockType);
            if (blockCount >= 1 && blockCount <= 10) {
                const amountToGive = 64 - blockCount;
                player.runCommand(`give @s ${primaryBlockType.replace('minecraft:', '')} ${amountToGive}`);
            }
        }
        if (player.hasTag('run')) {
            const blocksBelow = getBlocksBelow(player, BLOCK_CHECK_OFFSETS);
            
            // Check for finisher blocks (1-2 blocks below)
            if (blocksBelow.slice(0, 2).some(block => block?.typeId === FINISHER_BLOCK)) {
                stopRun(player);
            }
            
            // Check for coal blocks (1-3 blocks below)
            if (blocksBelow.some(block => block?.typeId === COAL_BLOCK)) {
                startRun(player);
            }
        }
        if (player.hasTag('freestyle')) {
            if (!player.hasTag('patternlearning')) {
                const showRcps = player.hasTag('rcps');
                const showBlocks = player.hasTag('blockamount');
                const blocks = totalBlocks.get(player) || 0;
                const parts = [];
                if (showRcps) parts.push(`§bRcps: §r${rCPS}`);
                if (showBlocks) parts.push(`§bBlocks: §r${blocks}`);
                if (parts.length) {
                    player.onScreenDisplay.setActionBar(parts.join(' §8| '));
                }
            }
        }
        if (player.location.y < voidLevel) {
            if (player.hasTag('freestyle')) {
                if (player.hasTag('noScore')) {
                    player.teleport(coords.freestyle.noScore.pos);
                    clearPlacedBlocksForPlayer(player);
                    totalBlocks.set(player, 0);
                } else if (player.hasTag('oneblock')) {
                    player.removeTag('startOneBlock');
                    system.runTimeout(() => {
                        const dim = world.getDimension("overworld");
                        dim.runCommand(`setblock 2000 49 1000 bedrock`);
                    }, 2);
                    player.teleport(coords.freestyle.oneBlock.pos);
                    clearPlacedBlocksForPlayer(player);
                    totalBlocks.set(player, 0);
                } else if (player.hasTag('customisland')) {
                    player.teleport(coords.freestyle.customIsland.pos);
                    clearPlacedBlocksForPlayer(player);
                    totalBlocks.set(player, 0);
                } else if (player.hasTag('patternlearning')) {
                    const runState = getPatternRunState(player);
                    if (runState.active) {
                        // Run has started: TP back, give items, clear placed blocks, set coords to trackerBlocks
                        player.teleport(coords.freestyle.patternLearning.pos);
                        clearPlacedBlocksForPlayer(player);
                        system.runTimeout(() => {
                            replaceDetectorsWithTrackers(player);
                        }, 5);
                        giveItem(player);
                        if (runState.timerId) {
                            system.clearRun(runState.timerId);
                            runState.timerId = null;
                        }
                        runState.active = false;
                        runState.startTime = null;
                    } else {
                        // Run hasn't started: TP back only
                        player.teleport(coords.freestyle.patternLearning.pos);
                    }
                    player.onScreenDisplay.setActionBar(`§cVoid!`);
                    clearPlacedBlocksForPlayer(player);
                    totalBlocks.set(player, 0);
                }
            }
            if (player.hasTag('run')) {
                // Handle void for speedbridge, parkour, gauntlet, bedwarsRush only
                const modeInfo = getModeAndVariant(player);
                if (modeInfo) {
                    respawnRun(player);
                }
            }
        }
    }
});

world.afterEvents.playerBreakBlock.subscribe(event => {
    const block = event.brokenBlockPermutation.getState;
    const blockType = event.brokenBlockPermutation.type?.id;
    const player = event.player;
    const { x, y, z } = event.block.location;
    
    // Handle detector block breaking in edit mode
    if (blockType === detectorBlockType && player.hasTag('patternlearning') && player.hasTag('buildmode')) {
        removePatternCoord(player, Math.floor(x), Math.floor(y), Math.floor(z));
        player.onScreenDisplay.setActionBar(`§cDetector removed! Coords removed.`);
    }
});

world.afterEvents.playerPlaceBlock.subscribe(event => {
    const block = event.block;
    const blockType = block?.typeId;
    const player = event.player;
    
    // Early validation
    if (!block || !player) return;
    
    const { x, y, z } = block.location;
    const isEditMode = player.hasTag('patternlearning') && player.hasTag('buildmode');
    const isDetectorBlock = blockType === detectorBlockType;
    const isTrackerBlock = blockType === trackerBlockType;
    
    // CASE 1: Edit mode - handle detector placement
    if (isEditMode && isDetectorBlock) {
        addPatternCoord(player, Math.floor(x), Math.floor(y), Math.floor(z));
        player.onScreenDisplay.setActionBar(`§aDetector placed! Coords saved.`);
        return;
    }
    
    // CASE 2: Admin or buildmode (non-edit) - skip all block tracking
    if (player.hasTag('admin') || player.hasTag('buildmode')) return;
    
    // CASE 3: Skip tracker/detector blocks in normal gameplay
    if (isDetectorBlock || isTrackerBlock) return;
    
    // CASE 4: Normal block placement
    setPlayerPrimaryBlock(player, blockType);
    
    // Track right clicks
    const playerClicks = rightClicks.get(player) || [];
    playerClicks.push({ timestamp: Date.now() });
    rightClicks.set(player, playerClicks);
    
    // Track block count for freestyle
    const current = totalBlocks.get(player) || 0;
    totalBlocks.set(player, current + 1);
    
    // Add to placed blocks list
    addPlacedBlockForPlayer(player, block.location, blockType);
    
    // Pattern Learning mode: start run on first block placement
    if (player.hasTag('patternlearning')) {
        const runState = getPatternRunState(player);
        if (!runState.active) {
            startPatternRun(player);
        }
        // Check if pattern is complete
        if (checkPatternCompletion(player)) {
            endPatternRun(player);
        }
    } else if (player.hasTag('run')) {
        startRun(player);
    }
    
    // One block mode special handling
    if (player.hasTag('oneblock') && player.hasTag('freestyle')) {
        if (!player.hasTag('startOneBlock')) {
            system.runTimeout(() => {
                const dim = world.getDimension("overworld");
                dim.runCommand(`setblock 2000 49 1000 air`);
            }, 20);
            player.addTag('startOneBlock');
        }
    }
});

function gatherTrackerCoords(origin, size = { x: 100, y: 30, z: 100 }) {
    const dim = world.getDimension("overworld");
    const found = [];

    const minX = Math.floor(origin.x) - Math.floor(size.x / 2);
    const minZ = Math.floor(origin.z) - Math.floor(size.z / 2);
    const minY = Math.floor(origin.y);

    const maxX = minX + size.x - 1;
    const maxY = minY + size.y - 1;
    const maxZ = minZ + size.z - 1;

    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            for (let z = minZ; z <= maxZ; z++) {
                const block = dim.getBlock({ x, y, z });
                if (block?.typeId === trackerBlockType) {
                    found.push({ x, y, z });
                }
            }
        }
    }

    return found;
}

function collectGauntletTrackerCoords(player) {
    if (!player.hasTag('admin')) return;
    const trackerCoords = gatherTrackerCoords(player.location, { x: 100, y: 30, z: 100 });
    
        trackerCoords.forEach(coord => {
        player.sendMessage(`${coord.x} ${coord.y} ${coord.z}`);
    });  
    player.sendMessage(`§aFound ${trackerCoords.length} tracker blocks:`);
    return trackerCoords;
}

// ===== PATTERN LEARNING HELPER FUNCTIONS =====

function getPatternCoordsForPlayer(player) {
    try {
        const coordsStr = player.getDynamicProperty?.('patternLearningCoords');
        if (coordsStr && typeof coordsStr === 'string') {
            return JSON.parse(coordsStr);
        }
        return [];
    } catch (err) {
        console.warn(`Failed to get pattern coords for ${player.name}:`, err);
        return [];
    }
}

function setPatternCoordsForPlayer(player, coords) {
    try {
        const jsonStr = JSON.stringify(Array.isArray(coords) ? coords : []);
        player.setDynamicProperty?.('patternLearningCoords', jsonStr);
    } catch (err) {
        console.warn(`Failed to save pattern coords for ${player.name}:`, err);
    }
}

function addPatternCoord(player, x, y, z) {
    const coords = getPatternCoordsForPlayer(player);
    const exists = coords.some(c => c.x === x && c.y === y && c.z === z);
    if (!exists) {
        coords.push({ x, y, z });
        setPatternCoordsForPlayer(player, coords);
    }
}

function removePatternCoord(player, x, y, z) {
    const coords = getPatternCoordsForPlayer(player);
    const filtered = coords.filter(c => !(c.x === x && c.y === y && c.z === z));
    setPatternCoordsForPlayer(player, filtered);
}

function replaceDetectorsWithTrackers(player) {
    const coords = getPatternCoordsForPlayer(player);
    if (!Array.isArray(coords) || coords.length === 0) return;
    
    for (const coord of coords) {
        system.runTimeout(() => {
            player.runCommand(`setblock ${coord.x} ${coord.y} ${coord.z} ${trackerBlockType}`);
        }, 5);
    }
}

function replaceTrackersWithDetectors(player) {
    const coords = getPatternCoordsForPlayer(player);
    if (!Array.isArray(coords) || coords.length === 0) return;
    
    for (const coord of coords) {
        system.runTimeout(() => {
            player.runCommand(`setblock ${coord.x} ${coord.y} ${coord.z} ${detectorBlockType}`);
        }, 5);
    }
}

function getPatternRunState(player) {
    const key = `patternRun_${player.name}`;
    if (!runState.has(key)) {
        runState.set(key, {
            active: false,
            startTime: null,
            timerId: null,
            targetCoords: []
        });
    }
    return runState.get(key);
}

function startPatternRun(player) {
    const runState = getPatternRunState(player);
    if (runState.active) return;
    
    runState.startTime = Date.now();
    runState.active = true;
    runState.targetCoords = getPatternCoordsForPlayer(player);
    
    // Clear dyes from inventory
    player.runCommand('clear @s red_dye');
    player.runCommand('clear @s yellow_dye');
    player.runCommand('clear @s orange_dye');
    player.runCommand('clear @s pink_dye');
    
    player.playSound("random.click");
    
    // Start timer if player has timer tag
    if (player.hasTag("timer")) {
        runState.timerId = system.runInterval(() => {
            const elapsed = ((Date.now() - runState.startTime) / 1000).toFixed(2);
            player.onScreenDisplay.setActionBar(`§bTime: §r${elapsed}`);
        });
    }
}

function endPatternRun(player) {
    const patternRunState = getPatternRunState(player);
    if (!patternRunState.active) return;
    
    // Clear timer
    if (patternRunState.timerId) {
        system.clearRun(patternRunState.timerId);
        patternRunState.timerId = null;
    }
    
    const elapsedMs = Date.now() - (patternRunState.startTime || Date.now());
    const elapsed = (elapsedMs / 1000).toFixed(2);
    
    player.playSound("random.levelup");
    player.onScreenDisplay.setActionBar(`§aPattern Completed!`);
    system.runTimeout(() => {
        if (player.hasTag("timer")) {
            player.onScreenDisplay.setTitle(`§bTime: §r${elapsed}`);
        }
    }, 1);
    
    patternRunState.active = false;
    patternRunState.startTime = null;
    
    // Clear inventory and teleport back
    player.runCommand('clear @s');
    system.runTimeout(() => {
        clearPlacedBlocksForPlayer(player);
        system.runTimeout(() => {
        replaceDetectorsWithTrackers(player);
        }, 5);
        giveItem(player);
        player.teleport(coords.freestyle.patternLearning.pos);
    }, 40);
}

function checkPatternCompletion(player) {
    if (!player.hasTag('patternlearning')) return false;
    
    const patternRunState = getPatternRunState(player);
    if (!patternRunState.active) return false;
    
    const placedBlocks = getPlayerPlacedBlocks(player);
    const targetCoords = patternRunState.targetCoords;
    
    if (!targetCoords || targetCoords.length === 0) return false;
    
    // Create set of target coords
    const targetSet = new Set();
    for (const coord of targetCoords) {
        targetSet.add(`${coord.x},${coord.y},${coord.z}`);
    }
    
    // Check if all target coords have been placed
    for (const coord of targetCoords) {
        const key = `${coord.x},${coord.y},${coord.z}`;
        const isPlaced = placedBlocks.some(b => b.x === coord.x && b.y === coord.y && b.z === coord.z);
        if (!isPlaced) return false;
    }
    
    return true;
}

//coords
const coords = {
    freestyle: {
        noScore: { 
            pos: { x: 1000.5, y: 50, z: 2000.5 },
            tickingArea: { x: 1000, y: 50, z: 2000 }
        },
        oneBlock: { 
            pos: { x: 2000.5, y: 51, z: 1000.5 },
            tickingArea: { x: 2000, y: 50, z: 1000 }
        },
        customIsland: { 
            pos: { x: 2000.5, y: 50, z: 2000.5 },
            tickingArea: { x: 2000, y: 50, z: 2000 }
        },
        patternLearning: { 
            pos: { x: 1000.5, y: 50, z: 1000.5 },
            tickingArea: { x: 1000, y: 50, z: 1000 }
        }
    },
    rush: {
        city: {
            pos: { x: -1999.5, y: 50, z: 1500.5 },
            facing: { x: -1999.5, y: 50, z: 1501.5 },
            tickingArea: { x: -2000, y: 50, z: 1660 }
        },
        paradise: {
            pos: { x: -1999.5, y: 50, z: 500.5 },            
            facing: { x: -1999.5, y: 50, z: 501.5 },
            tickingArea: { x: -1991, y: 50, z: 640 }
        },
        citadel: {
            pos: { x: -1999.5, y: 50, z: -499.5 },
            facing: { x: -1999.5, y: 50, z: -500.5 },
            tickingArea: { x: -1997, y: 50, z: -600 }
        },
        luck: {
            pos: { x: -1999.5, y: 50, z: -1499.5 },
            facing: { x: -1999.5, y: 50, z: -1498.5 },
            tickingArea: { x: -2000, y: 50, z: -1345 }
        },
        village: {
            pos: { x: -999.5, y: 50, z: 1500.5 },
            facing: { x: -999.5, y: 50, z: 1499.5 },
            tickingArea: { x: -1004, y: 50, z: 1420 }
        },
        wasteland: {
            pos: { x: -999.5, y: 50, z: 500.5 },
            facing: { x: -999.5, y: 50, z: 499.5 },
            tickingArea: { x: -1000, y: 50, z: 380 }
        },
        nether: {
            pos: { x: -999.5, y: 50, z: -499.5 },
            facing: { x: -1000.5, y: 50, z: -499.5 },
            tickingArea: { x: -1110, y: 50, z: -500 }
        },
        temple: {
            pos: { x: -999.5, y: 50, z: -1499.5 },
            facing: { x: -999.5, y: 50, z: -1500.5 },
            tickingArea: { x: -1002, y: 50, z: -1605 }
        }
    },
    speedbridge: {
        short: {
            no1: {
                pos: { x: 460.5, y: 50, z: -500.5 },
                facing: { x: 460.5, y: 50, z: -501.5 }
            },
            no2: {
                pos: { x: 480.5, y: 50, z: -500.5 },
                facing: { x: 480.5, y: 50, z: -501.5 }
            },
            no3: {
                pos: { x: 500.5, y: 50, z: -500.5 },
                facing: { x: 500.5, y: 50, z: -501.5 }
            },
            no4: {
                pos: { x: 520.5, y: 50, z: -500.5 },
                facing: { x: 520.5, y: 50, z: -501.5 }
            },
            no5: {
                pos: { x: 540.5, y: 50, z: -500.5 },
                facing: { x: 540.5, y: 50, z: -501.5 }
            },
            tickingArea: { x: 500, y: 50, z: -500 }
        },
        normal: {
            no1: {
                pos: { x: 960.5, y: 50, z: -500.5 },
                facing: { x: 960.5, y: 50, z: -501.5 }
            },
            no2: {
                pos: { x: 980.5, y: 50, z: -500.5 },
                facing: { x: 980.5, y: 50, z: -501.5 }
            },
            no3: {
                pos: { x: 1000.5, y: 50, z: -500.5 },
                facing: { x: 1000.5, y: 50, z: -501.5 }
            },
            no4: {
                pos: { x: 1020.5, y: 50, z: -500.5 },
                facing: { x: 1020.5, y: 50, z: -501.5 }
            },
            no5: {
                pos: { x: 1040.5, y: 50, z: -500.5 },
                facing: { x: 1040.5, y: 50, z: -501.5 }
            },
            tickingArea: { x: 1000, y: 50, z: -500 }
        },
        long: {
            no1: {
                pos: { x: 1460.5, y: 50, z: -500.5 },
                facing: { x: 1460.5, y: 50, z: -501.5 }
            },
            no2: {
                pos: { x: 1480.5, y: 50, z: -500.5 },
                facing: { x: 1480.5, y: 50, z: -501.5 }
            },
            no3: {
                pos: { x: 1500.5, y: 50, z: -500.5 },
                facing: { x: 1500.5, y: 50, z: -501.5 }
            },
            no4: {
                pos: { x: 1520.5, y: 50, z: -500.5 },
                facing: { x: 1520.5, y: 50, z: -501.5 }
            },
            no5: {
                pos: { x: 1540.5, y: 50, z: -500.5 },
                facing: { x: 1540.5, y: 50, z: -501.5 }
            },
            tickingArea: { x: 1500, y: 50, z: -500 }
        },
        stackUp: {
            no1: {
                pos: { x: 960.5, y: 50, z: -1000.5 },
                facing: { x: 960.5, y: 50, z: -1001.5 }
            },
            no2: {
                pos: { x: 980.5, y: 50, z: -1000.5 },
                facing: { x: 980.5, y: 50, z: -1001.5 }
            },
            no3: {
                pos: { x: 1000.5, y: 50, z: -1000.5 },
                facing: { x: 1000.5, y: 50, z: -1001.5 }
            },
            no4: {
                pos: { x: 1020.5, y: 50, z: -1000.5 },
                facing: { x: 1020.5, y: 50, z: -1001.5 }
            },
            no5: {
                pos: { x: 1040.5, y: 50, z: -1000.5 },
                facing: { x: 1040.5, y: 50, z: -1001.5 }
            },
            tickingArea: { x: 1000, y: 50, z: -1000 }
        },
        shortDiagonal: {
            no1: {
                pos: { x: 1471.5, y: 50, z: -1030.5 },
                facing: { x: 1472.5, y: 50, z: -1031.5 }
            },
            no2: {
                pos: { x: 1486.5, y: 50, z: -1015.5 },
                facing: { x: 1487.5, y: 50, z: -1016.5 }
            },
            no3: {
                pos: { x: 1501.5, y: 50, z: -1000.5 },
                facing: { x: 1502.5, y: 50, z: -1001.5 }
            },
            no4: {
                pos: { x: 1516.5, y: 50, z: -985.5 },
                facing: { x: 1517.5, y: 50, z: -986.5 }
            },
            no5: {
                pos: { x: 1531.5, y: 50, z: -970.5 },
                facing: { x: 1532.5, y: 50, z: -971.5 }
            },
            tickingArea: { x: 1500, y: 50, z: -1000 }
        },
        diagonal: {
            no1: {
                pos: { x: 469.5, y: 50, z: -970.5 },
                facing: { x: 468.5, y: 50, z: -971.5 }
            },
            no2: {
                pos: { x: 484.5, y: 50, z: -985.5 },
                facing: { x: 483.5, y: 50, z: -986.5 }
            },
            no3: {
                pos: { x: 499.5, y: 50, z: -1000.5 },
                facing: { x: 498.5, y: 50, z: -1001.5 }
            },
            no4: {
                pos: { x: 514.5, y: 50, z: -1015.5 },
                facing: { x: 513.5, y: 50, z: -1016.5 }
            },
            no5: {
                pos: { x: 529.5, y: 50, z: -1030.5 },
                facing: { x: 528.5, y: 50, z: -1031.5 }
            },
            tickingArea: { x: 500, y: 50, z: -1000 }
        }
    },
    parkour: {
        pcourse1: {
            pos: { x: 500.5, y: 50, z: -1500.5 },
            facing: { x: 500.5, y: 50, z: -1499.5 },
            tickingArea: { x: 500, y: 50, z: -1500 }
        },
        pcourse2: {
            pos: { x: 1000.5, y: 50, z: -1500.5 },
            facing: { x: 1000.5, y: 50, z: -1499.5 },
            tickingArea: { x: 1000, y: 50, z: -1500 }
        },
        pcourse3: {
            pos: { x: 1500.5, y: 50, z: -1500.5 },
            facing: { x: 1500.5, y: 50, z: -1499.5 },
            tickingArea: { x: 1500, y: 50, z: -1500 }
        },
        pcourse4: {
            pos: { x: 2000.5, y: 50, z: -1500.5 },
            facing: { x: 2000.5, y: 50, z: -1499.5 },
            tickingArea: { x: 2000, y: 50, z: -1500 }
        },
        pcourse5: {
            pos: { x: 2500.5, y: 50, z: -1500.5 },
            facing: { x: 2500.5, y: 50, z: -1499.5 },
            tickingArea: { x: 2500, y: 50, z: -1500 }
        },
        pcourse6: {
            pos: { x: 500.5, y: 50, z: -2000.5 },
            facing: { x: 500.5, y: 50, z: -1999.5 },
            tickingArea: { x: 500, y: 50, z: -2000 }
        },
        pcourse7: {
            pos: { x: 1000.5, y: 50, z: -2000.5 },
            facing: { x: 1000.5, y: 50, z: -1999.5 },
            tickingArea: { x: 1000, y: 50, z: -2000 }
        },
        pcourse8: {
            pos: { x: 1500.5, y: 50, z: -2000.5 },
            facing: { x: 1500.5, y: 50, z: -1999.5 },
            tickingArea: { x: 1500, y: 50, z: -2000 }
        },
        pcourse9: {
            pos: { x: 2000.5, y: 50, z: -2000.5 },
            facing: { x: 2000.5, y: 50, z: -1999.5 },
            tickingArea: { x: 2000, y: 50, z: -2000 }
        },
        pcourse10: {
            pos: { x: 2498.5, y: 50, z: -2000.5 },
            facing: { x: 2499.5, y: 50, z: -1999.5 },
            tickingArea: { x: 2500, y: 50, z: -2000 }
        }
    },
    gauntlet: {
        gcourse1: {
            pos: { x: -1999.5, y: 50, z: -3000.5 },
            facing: { x: -1999.5, y: 50, z: -2999.5 },
            tickingArea: { x: -2000, y: 0, z: -2950 },
            tracker: [
                { x: -2003, y: 51, z: -2927 },
                { x: -2002, y: 49, z: -2937 },
                { x: -2002, y: 51, z: -2923 },
                { x: -2002, y: 52, z: -2916 },
                { x: -2002, y: 52, z: -2915 },
                { x: -2002, y: 52, z: -2914 },
                { x: -2002, y: 52, z: -2913 },
                { x: -2002, y: 52, z: -2912 },
                { x: -2001, y: 48, z: -2977 },
                { x: -2001, y: 48, z: -2956 },
                { x: -2001, y: 48, z: -2955 },
                { x: -2001, y: 48, z: -2954 },
                { x: -2001, y: 48, z: -2953 },
                { x: -2001, y: 48, z: -2952 },
                { x: -2001, y: 48, z: -2951 },
                { x: -2001, y: 48, z: -2950 },
                { x: -2001, y: 48, z: -2949 },
                { x: -2001, y: 48, z: -2948 },
                { x: -2001, y: 48, z: -2947 },
                { x: -2001, y: 48, z: -2946 },
                { x: -2001, y: 51, z: -2992 },
                { x: -1999, y: 48, z: -2973 },
                { x: -1999, y: 48, z: -2963 },
                { x: -1999, y: 50, z: -2995 },
                { x: -1998, y: 48, z: -2972 },
                { x: -1998, y: 48, z: -2964 },
                { x: -1997, y: 48, z: -2971 },
                { x: -1997, y: 48, z: -2965 },
                { x: -1996, y: 48, z: -2970 },
                { x: -1996, y: 48, z: -2966 }
            ]
        },
        gcourse2: {
            pos: { x: -999.5, y: 50, z: -3000.5 },
            facing: { x: -999.5, y: 50, z: -2999.5 },
            tickingArea: { x: -1000, y: 0, z: -2950 },
            tracker: [ 
                { x: -1001, y: 49, z: -2988 },
                { x: -1001, y: 49, z: -2987 },
                { x: -1001, y: 49, z: -2986 },
                { x: -1001, y: 49, z: -2985 },
                { x: -1001, y: 51, z: -2925 },
                { x: -1000, y: 49, z: -2994 },
                { x: -1000, y: 49, z: -2993 },
                { x: -1000, y: 49, z: -2992 },
                { x: -1000, y: 49, z: -2991 },
                { x: -1000, y: 49, z: -2988 },
                { x: -1000, y: 49, z: -2985 },
                { x: -1000, y: 49, z: -2984 },
                { x: -1000, y: 49, z: -2983 },
                { x: -1000, y: 50, z: -2975 },
                { x: -1000, y: 50, z: -2974 },
                { x: -1000, y: 50, z: -2960 },
                { x: -1000, y: 50, z: -2957 },
                { x: -1000, y: 51, z: -2960 },
                { x: -1000, y: 51, z: -2957 },
                { x: -1000, y: 51, z: -2940 },
                { x: -1000, y: 51, z: -2939 },
                { x: -1000, y: 51, z: -2938 },
                { x: -1000, y: 51, z: -2937 },
                { x: -1000, y: 51, z: -2936 },
                { x: -1000, y: 51, z: -2935 },
                { x: -1000, y: 51, z: -2934 },
                { x: -1000, y: 51, z: -2933 },
                { x: -1000, y: 51, z: -2932 },
                { x: -1000, y: 51, z: -2925 },
                { x: -1000, y: 51, z: -2921 },
                { x: -1000, y: 52, z: -2957 },
                { x: -999, y: 49, z: -2991 },
                { x: -999, y: 49, z: -2990 },
                { x: -999, y: 49, z: -2989 },
                { x: -999, y: 49, z: -2988 },
                { x: -999, y: 51, z: -2921 }
            ]
        },
        gcourse3: {
            pos: { x: 0.5, y: 50, z: -3000.5 },
            facing: { x: 0.5, y: 50, z: -2999.5 },
            tickingArea: { x: -5, y: 0, z: -2950 },
            tracker: [
                { x: -5, y: 50, z: -2981 },
                { x: -4, y: 50, z: -2982 },
                { x: -3, y: 50, z: -2983 },
                { x: -2, y: 50, z: -2984 },
                { x: -1, y: 50, z: -2985 },
                { x: 0, y: 50, z: -2986 },
                { x: 0, y: 51, z: -2963 },
                { x: 0, y: 51, z: -2962 },
                { x: 0, y: 52, z: -2929 },
                { x: 0, y: 52, z: -2928 },
                { x: 0, y: 52, z: -2927 },
                { x: 0, y: 52, z: -2926 },
                { x: 0, y: 52, z: -2925 },
                { x: 1, y: 51, z: -2970 },
                { x: 1, y: 51, z: -2969 },
                { x: 1, y: 51, z: -2964 },
                { x: 1, y: 51, z: -2963 },
                { x: 1, y: 51, z: -2962 },
                { x: 1, y: 51, z: -2961 },
                { x: 1, y: 52, z: -2929 },
                { x: 1, y: 52, z: -2925 },
                { x: 2, y: 51, z: -2969 },
                { x: 2, y: 51, z: -2968 },
                { x: 2, y: 51, z: -2965 },
                { x: 2, y: 51, z: -2964 },
                { x: 2, y: 51, z: -2961 },
                { x: 2, y: 51, z: -2960 },
                { x: 2, y: 52, z: -2953 },
                { x: 2, y: 52, z: -2952 },
                { x: 2, y: 52, z: -2934 },
                { x: 2, y: 52, z: -2933 },
                { x: 2, y: 52, z: -2929 },
                { x: 2, y: 52, z: -2925 },
                { x: 2, y: 52, z: -2921 },
                { x: 2, y: 52, z: -2920 },
                { x: 2, y: 52, z: -2919 },
                { x: 2, y: 52, z: -2918 },
                { x: 2, y: 52, z: -2917 },
                { x: 3, y: 51, z: -2968 },
                { x: 3, y: 51, z: -2967 },
                { x: 3, y: 51, z: -2966 },
                { x: 3, y: 51, z: -2965 },
                { x: 3, y: 52, z: -2933 },
                { x: 3, y: 52, z: -2929 },
                { x: 3, y: 52, z: -2925 },
                { x: 3, y: 52, z: -2921 },
                { x: 4, y: 51, z: -2967 },
                { x: 4, y: 51, z: -2966 },
                { x: 4, y: 52, z: -2933 },
                { x: 4, y: 52, z: -2932 },
                { x: 4, y: 52, z: -2931 },
                { x: 4, y: 52, z: -2930 },
                { x: 4, y: 52, z: -2929 },
                { x: 4, y: 52, z: -2925 },
                { x: 4, y: 52, z: -2924 },
                { x: 4, y: 52, z: -2923 },
                { x: 4, y: 52, z: -2922 },
                { x: 4, y: 52, z: -2921 }
            ]
        },
        gcourse4: {
            pos: { x: 1000.5, y: 50, z: -3000.5 },
            facing: { x: 1000.5, y: 50, z: -2999.5 },
            tickingArea: { x: 995, y: 0, z: -2980 },
            tracker: [
                { x: 992, y: 51, z: -2926 },
                { x: 993, y: 51, z: -2926 },
                { x: 993, y: 53, z: -2912 },
                { x: 993, y: 53, z: -2911 },
                { x: 993, y: 53, z: -2909 },
                { x: 993, y: 53, z: -2908 },
                { x: 994, y: 49, z: -2980 },
                { x: 994, y: 49, z: -2979 },
                { x: 994, y: 49, z: -2978 },
                { x: 995, y: 49, z: -2982 },
                { x: 995, y: 49, z: -2981 },
                { x: 995, y: 49, z: -2980 },
                { x: 995, y: 49, z: -2978 },
                { x: 995, y: 49, z: -2977 },
                { x: 995, y: 49, z: -2976 },
                { x: 996, y: 49, z: -2983 },
                { x: 996, y: 49, z: -2982 },
                { x: 996, y: 49, z: -2976 },
                { x: 996, y: 49, z: -2975 },
                { x: 997, y: 49, z: -2984 },
                { x: 997, y: 49, z: -2983 },
                { x: 997, y: 49, z: -2975 },
                { x: 997, y: 49, z: -2974 },
                { x: 997, y: 50, z: -2933 },
                { x: 997, y: 51, z: -2933 },
                { x: 998, y: 49, z: -2984 },
                { x: 998, y: 49, z: -2974 },
                { x: 999, y: 49, z: -2985 },
                { x: 999, y: 49, z: -2984 },
                { x: 999, y: 49, z: -2974 },
                { x: 999, y: 49, z: -2973 },
                { x: 1000, y: 49, z: -2985 },
                { x: 1000, y: 50, z: -2946 },
                { x: 1000, y: 50, z: -2945 },
                { x: 1000, y: 50, z: -2944 },
                { x: 1000, y: 50, z: -2936 },
                { x: 1000, y: 50, z: -2935 },
                { x: 1000, y: 52, z: -2967 },
                { x: 1000, y: 52, z: -2966 },
                { x: 1000, y: 52, z: -2965 },
                { x: 1000, y: 52, z: -2964 },
                { x: 1000, y: 52, z: -2963 },
                { x: 1000, y: 52, z: -2962 },
                { x: 1000, y: 52, z: -2961 },
                { x: 1000, y: 52, z: -2960 },
                { x: 1000, y: 52, z: -2959 },
                { x: 1000, y: 52, z: -2958 },
                { x: 1001, y: 50, z: -2944 },
                { x: 1001, y: 50, z: -2943 },
                { x: 1001, y: 50, z: -2937 },
                { x: 1001, y: 50, z: -2936 },
                { x: 1002, y: 50, z: -2943 },
                { x: 1002, y: 50, z: -2942 },
                { x: 1002, y: 50, z: -2938 },
                { x: 1002, y: 50, z: -2937 },
                { x: 1003, y: 50, z: -2942 },
                { x: 1003, y: 50, z: -2941 },
                { x: 1003, y: 50, z: -2939 },
                { x: 1003, y: 50, z: -2938 },
                { x: 1004, y: 50, z: -2941 },
                { x: 1004, y: 50, z: -2940 },
                { x: 1004, y: 50, z: -2939 }
            ]
        },
        gcourse5: {
            pos: { x: 2000.5, y: 50, z: -3000.5 },
            facing: { x: 2000.5, y: 50, z: -2999.5 },
            tickingArea: { x: 2000, y: 0, z: -2950 },
            tracker: [
                { x: 1986, y: 50, z: -2922 },
                { x: 1987, y: 50, z: -2921 },
                { x: 1988, y: 50, z: -2920 },
                { x: 1989, y: 49, z: -2926 },
                { x: 1990, y: 49, z: -2927 },
                { x: 1991, y: 49, z: -2928 },
                { x: 1992, y: 51, z: -2915 },
                { x: 1993, y: 51, z: -2914 },
                { x: 1994, y: 51, z: -2913 },
                { x: 1996, y: 48, z: -2932 },
                { x: 1997, y: 48, z: -2933 },
                { x: 1998, y: 48, z: -2934 },
                { x: 2000, y: 49, z: -2994 },
                { x: 2000, y: 49, z: -2991 },
                { x: 2000, y: 49, z: -2988 },
                { x: 2000, y: 50, z: -2991 },
                { x: 2000, y: 50, z: -2988 },
                { x: 2000, y: 50, z: -2985 },
                { x: 2000, y: 51, z: -2988 },
                { x: 2000, y: 51, z: -2985 },
                { x: 2000, y: 51, z: -2979 },
                { x: 2000, y: 51, z: -2978 },
                { x: 2000, y: 52, z: -2985 },
                { x: 2000, y: 54, z: -2950 },
                { x: 2000, y: 54, z: -2949 },
                { x: 2000, y: 54, z: -2948 },
                { x: 2000, y: 54, z: -2947 },
                { x: 2000, y: 54, z: -2946 },
                { x: 2000, y: 54, z: -2945 }
            ]
        },
        gcourse6: {
            pos: { x: -1998.5, y: 50, z: -4000.5 },
            facing: { x: -1999.5, y: 50, z: -3999.5 },
            tickingArea: { x: -2020, y: 0, z: -3960 },
            tracker: [
                { x: -2044, y: 55, z: -3958 },
                { x: -2044, y: 55, z: -3957 },
                { x: -2044, y: 55, z: -3956 },
                { x: -2044, y: 56, z: -3950 },
                { x: -2044, y: 56, z: -3949 },
                { x: -2043, y: 55, z: -3960 },
                { x: -2043, y: 55, z: -3959 },
                { x: -2043, y: 55, z: -3958 },
                { x: -2042, y: 55, z: -3962 },
                { x: -2042, y: 55, z: -3961 },
                { x: -2042, y: 55, z: -3960 },
                { x: -2041, y: 55, z: -3962 },
                { x: -2040, y: 55, z: -3963 },
                { x: -2040, y: 55, z: -3962 },
                { x: -2039, y: 55, z: -3963 },
                { x: -2038, y: 55, z: -3964 },
                { x: -2038, y: 55, z: -3963 },
                { x: -2037, y: 55, z: -3964 },
                { x: -2036, y: 55, z: -3966 },
                { x: -2036, y: 55, z: -3965 },
                { x: -2036, y: 55, z: -3964 },
                { x: -2035, y: 55, z: -3968 },
                { x: -2035, y: 55, z: -3967 },
                { x: -2035, y: 55, z: -3966 },
                { x: -2034, y: 55, z: -3970 },
                { x: -2034, y: 55, z: -3969 },
                { x: -2034, y: 55, z: -3968 },
                { x: -2033, y: 55, z: -3971 },
                { x: -2033, y: 55, z: -3970 },
                { x: -2025, y: 53, z: -3977 },
                { x: -2025, y: 54, z: -3974 },
                { x: -2022, y: 52, z: -3977 },
                { x: -2019, y: 51, z: -3981 },
                { x: -2018, y: 51, z: -3981 },
                { x: -2017, y: 51, z: -3981 },
                { x: -2016, y: 51, z: -3981 },
                { x: -2015, y: 51, z: -3985 },
                { x: -2015, y: 51, z: -3984 },
                { x: -2015, y: 51, z: -3983 },
                { x: -2015, y: 51, z: -3982 },
                { x: -2012, y: 51, z: -3989 },
                { x: -2011, y: 51, z: -3990 },
                { x: -2010, y: 51, z: -3991 },
                { x: -2009, y: 51, z: -3992 },
                { x: -2006, y: 50, z: -3995 },
                { x: -2005, y: 50, z: -3996 }
            ]
        },
        gcourse7: {
            pos: { x: -999.5, y: 50, z: -4000.5 },
            facing: { x: -999.5, y: 50, z: -3999.5 },
            tickingArea: { x: -1000, y: 0, z: -3950 },
            tracker: [
                { x: -1013, y: 59, z: -3929 },
                { x: -1009, y: 58, z: -3924 },
                { x: -1008, y: 58, z: -3924 },
                { x: -1008, y: 58, z: -3923 },
                { x: -1007, y: 58, z: -3923 },
                { x: -1007, y: 58, z: -3922 },
                { x: -1006, y: 58, z: -3922 },
                { x: -1006, y: 58, z: -3921 },
                { x: -1005, y: 58, z: -3921 },
                { x: -1005, y: 58, z: -3920 },
                { x: -1004, y: 58, z: -3921 },
                { x: -1004, y: 58, z: -3920 },
                { x: -1003, y: 58, z: -3922 },
                { x: -1003, y: 58, z: -3921 },
                { x: -1002, y: 58, z: -3923 },
                { x: -1002, y: 58, z: -3922 },
                { x: -1001, y: 49, z: -3994 },
                { x: -1001, y: 51, z: -3989 },
                { x: -1001, y: 53, z: -3983 },
                { x: -1001, y: 58, z: -3928 },
                { x: -1001, y: 58, z: -3927 },
                { x: -1001, y: 58, z: -3924 },
                { x: -1001, y: 58, z: -3923 },
                { x: -1000, y: 54, z: -3977 },
                { x: -1000, y: 54, z: -3976 },
                { x: -1000, y: 54, z: -3975 },
                { x: -1000, y: 56, z: -3964 },
                { x: -1000, y: 56, z: -3963 },
                { x: -1000, y: 56, z: -3962 },
                { x: -1000, y: 56, z: -3961 },
                { x: -1000, y: 56, z: -3960 },
                { x: -1000, y: 56, z: -3959 },
                { x: -1000, y: 56, z: -3958 },
                { x: -1000, y: 57, z: -3936 },
                { x: -1000, y: 57, z: -3935 },
                { x: -1000, y: 58, z: -3931 },
                { x: -1000, y: 58, z: -3930 },
                { x: -1000, y: 58, z: -3929 },
                { x: -1000, y: 58, z: -3928 },
                { x: -1000, y: 58, z: -3927 },
                { x: -1000, y: 58, z: -3926 },
                { x: -1000, y: 58, z: -3925 },
                { x: -1000, y: 58, z: -3924 },
                { x: -1000, y: 59, z: -3953 },
                { x: -1000, y: 59, z: -3952 },
                { x: -1000, y: 59, z: -3951 },
                { x: -1000, y: 59, z: -3950 },
                { x: -1000, y: 59, z: -3949 },
                { x: -1000, y: 59, z: -3948 },
                { x: -1000, y: 59, z: -3947 },
                { x: -1000, y: 59, z: -3946 },
                { x: -1000, y: 59, z: -3945 },
                { x: -1000, y: 59, z: -3944 },
                { x: -1000, y: 59, z: -3943 },
                { x: -999, y: 50, z: -3991 },
                { x: -999, y: 52, z: -3986 },
                { x: -999, y: 58, z: -3930 },
                { x: -999, y: 58, z: -3929 },
                { x: -999, y: 58, z: -3926 },
                { x: -999, y: 58, z: -3925 }
            ]
        },
        gcourse8: {
            pos: { x: 0.5, y: 50, z: -4000.5 },
            facing: { x: 0.5, y: 50, z: -3999.5 },
            tickingArea: { x: -5, y: 0, z: -3950 },
            tracker: [
                { x: -7, y: 54, z: -3949 },
                { x: -7, y: 56, z: -3942 },
                { x: -7, y: 58, z: -3934 },
                { x: -7, y: 58, z: -3933 },
                { x: -7, y: 58, z: -3932 },
                { x: -7, y: 58, z: -3931 },
                { x: -7, y: 58, z: -3930 },
                { x: -7, y: 58, z: -3929 },
                { x: -7, y: 58, z: -3928 },
                { x: -7, y: 58, z: -3927 },
                { x: -7, y: 58, z: -3926 },
                { x: -7, y: 58, z: -3925 },
                { x: -7, y: 58, z: -3924 },
                { x: -7, y: 58, z: -3923 },
                { x: -7, y: 59, z: -3918 },
                { x: -7, y: 59, z: -3917 },
                { x: -6, y: 53, z: -3954 },
                { x: -6, y: 55, z: -3945 },
                { x: -5, y: 53, z: -3959 },
                { x: -5, y: 53, z: -3958 },
                { x: -5, y: 53, z: -3955 },
                { x: -5, y: 53, z: -3954 },
                { x: -4, y: 53, z: -3960 },
                { x: -4, y: 53, z: -3959 },
                { x: -4, y: 53, z: -3958 },
                { x: -4, y: 53, z: -3957 },
                { x: -4, y: 53, z: -3956 },
                { x: -4, y: 53, z: -3955 },
                { x: -3, y: 53, z: -3960 },
                { x: -3, y: 53, z: -3959 },
                { x: -3, y: 53, z: -3957 },
                { x: -3, y: 53, z: -3956 },
                { x: -2, y: 53, z: -3959 },
                { x: -2, y: 53, z: -3958 },
                { x: -1, y: 53, z: -3963 },
                { x: -1, y: 53, z: -3962 },
                { x: -1, y: 53, z: -3959 },
                { x: -1, y: 53, z: -3958 },
                { x: 0, y: 48, z: -3994 },
                { x: 0, y: 49, z: -3994 },
                { x: 0, y: 49, z: -3991 },
                { x: 0, y: 50, z: -3994 },
                { x: 0, y: 50, z: -3991 },
                { x: 0, y: 51, z: -3991 },
                { x: 0, y: 53, z: -3966 },
                { x: 0, y: 53, z: -3965 },
                { x: 0, y: 53, z: -3964 },
                { x: 0, y: 53, z: -3963 },
                { x: 0, y: 53, z: -3962 },
                { x: 0, y: 53, z: -3961 },
                { x: 0, y: 53, z: -3960 },
                { x: 0, y: 53, z: -3959 },
                { x: 0, y: 56, z: -3979 },
                { x: 0, y: 56, z: -3978 },
                { x: 0, y: 56, z: -3977 },
                { x: 0, y: 56, z: -3976 },
                { x: 0, y: 56, z: -3975 },
                { x: 0, y: 56, z: -3974 },
                { x: 0, y: 56, z: -3973 },
                { x: 0, y: 56, z: -3972 },
                { x: 0, y: 56, z: -3971 },
                { x: 0, y: 56, z: -3970 },
                { x: 1, y: 53, z: -3965 },
                { x: 1, y: 53, z: -3964 },
                { x: 1, y: 53, z: -3961 },
                { x: 1, y: 53, z: -3960 }
            ]
        },
        gcourse9: {
            pos: { x: 1000.5, y: 50, z: -4000.5 },
            facing: { x: 1000.5, y: 50, z: -3999.5 },
            tickingArea: { x: 995, y: 0, z: -3950 },
            tracker: [
                { x: 985, y: 59, z: -3927 },
                { x: 985, y: 59, z: -3926 },
                { x: 985, y: 59, z: -3925 },
                { x: 985, y: 59, z: -3921 },
                { x: 985, y: 59, z: -3920 },
                { x: 985, y: 59, z: -3919 },
                { x: 986, y: 59, z: -3930 },
                { x: 986, y: 59, z: -3929 },
                { x: 986, y: 59, z: -3927 },
                { x: 986, y: 59, z: -3925 },
                { x: 986, y: 59, z: -3924 },
                { x: 986, y: 59, z: -3923 },
                { x: 986, y: 59, z: -3921 },
                { x: 986, y: 59, z: -3919 },
                { x: 986, y: 59, z: -3918 },
                { x: 986, y: 59, z: -3917 },
                { x: 987, y: 57, z: -3940 },
                { x: 987, y: 59, z: -3929 },
                { x: 987, y: 59, z: -3927 },
                { x: 987, y: 59, z: -3926 },
                { x: 987, y: 59, z: -3923 },
                { x: 987, y: 59, z: -3921 },
                { x: 987, y: 59, z: -3920 },
                { x: 987, y: 59, z: -3917 },
                { x: 987, y: 59, z: -3916 },
                { x: 987, y: 59, z: -3915 },
                { x: 988, y: 59, z: -3930 },
                { x: 988, y: 59, z: -3929 },
                { x: 988, y: 59, z: -3926 },
                { x: 988, y: 59, z: -3924 },
                { x: 988, y: 59, z: -3923 },
                { x: 988, y: 59, z: -3920 },
                { x: 988, y: 59, z: -3915 },
                { x: 989, y: 59, z: -3930 },
                { x: 989, y: 59, z: -3928 },
                { x: 989, y: 59, z: -3927 },
                { x: 989, y: 59, z: -3926 },
                { x: 989, y: 59, z: -3924 },
                { x: 989, y: 59, z: -3922 },
                { x: 989, y: 59, z: -3921 },
                { x: 989, y: 59, z: -3920 },
                { x: 989, y: 59, z: -3915 },
                { x: 989, y: 59, z: -3914 },
                { x: 990, y: 59, z: -3930 },
                { x: 990, y: 59, z: -3929 },
                { x: 990, y: 59, z: -3928 },
                { x: 990, y: 59, z: -3923 },
                { x: 990, y: 59, z: -3922 },
                { x: 990, y: 59, z: -3914 },
                { x: 991, y: 59, z: -3914 },
                { x: 991, y: 59, z: -3913 },
                { x: 992, y: 57, z: -3944 },
                { x: 996, y: 56, z: -3949 },
                { x: 997, y: 56, z: -3950 },
                { x: 997, y: 56, z: -3949 },
                { x: 998, y: 56, z: -3951 },
                { x: 998, y: 56, z: -3950 },
                { x: 999, y: 56, z: -3960 },
                { x: 999, y: 56, z: -3959 },
                { x: 999, y: 56, z: -3958 },
                { x: 999, y: 56, z: -3952 },
                { x: 999, y: 56, z: -3951 },
                { x: 1000, y: 50, z: -3994 },
                { x: 1000, y: 50, z: -3993 },
                { x: 1000, y: 53, z: -3980 },
                { x: 1000, y: 53, z: -3979 },
                { x: 1000, y: 54, z: -3976 },
                { x: 1000, y: 54, z: -3975 },
                { x: 1000, y: 54, z: -3974 },
                { x: 1000, y: 54, z: -3973 },
                { x: 1000, y: 54, z: -3972 },
                { x: 1000, y: 54, z: -3971 },
                { x: 1000, y: 54, z: -3970 },
                { x: 1000, y: 56, z: -3962 },
                { x: 1000, y: 56, z: -3961 },
                { x: 1000, y: 56, z: -3960 },
                { x: 1000, y: 56, z: -3958 },
                { x: 1000, y: 56, z: -3957 },
                { x: 1000, y: 56, z: -3956 },
                { x: 1000, y: 56, z: -3954 },
                { x: 1000, y: 56, z: -3953 },
                { x: 1000, y: 56, z: -3952 },
                { x: 1001, y: 56, z: -3956 },
                { x: 1001, y: 56, z: -3955 },
                { x: 1001, y: 56, z: -3954 }
            ]
        },
        gcourse10: {
            pos: { x: 2000.5, y: 50, z: -4000.5 },
            facing: { x: 2000.5, y: 50, z: -3999.5 },
            tickingArea: { x: 1995, y: 0, z: -3950 },
            tracker: [
                { x: 1992, y: 54, z: -3937 },
                { x: 1992, y: 54, z: -3936 },
                { x: 1994, y: 49, z: -3983 },
                { x: 1994, y: 49, z: -3982 },
                { x: 1994, y: 49, z: -3981 },
                { x: 1994, y: 49, z: -3959 },
                { x: 1994, y: 49, z: -3958 },
                { x: 1994, y: 49, z: -3957 },
                { x: 1994, y: 52, z: -3942 },
                { x: 1995, y: 49, z: -3985 },
                { x: 1995, y: 49, z: -3984 },
                { x: 1995, y: 49, z: -3983 },
                { x: 1995, y: 49, z: -3981 },
                { x: 1995, y: 49, z: -3980 },
                { x: 1995, y: 49, z: -3979 },
                { x: 1995, y: 49, z: -3961 },
                { x: 1995, y: 49, z: -3960 },
                { x: 1995, y: 49, z: -3959 },
                { x: 1995, y: 49, z: -3957 },
                { x: 1995, y: 49, z: -3956 },
                { x: 1995, y: 49, z: -3955 },
                { x: 1995, y: 52, z: -3942 },
                { x: 1996, y: 49, z: -3986 },
                { x: 1996, y: 49, z: -3985 },
                { x: 1996, y: 49, z: -3979 },
                { x: 1996, y: 49, z: -3978 },
                { x: 1996, y: 49, z: -3962 },
                { x: 1996, y: 49, z: -3961 },
                { x: 1996, y: 49, z: -3955 },
                { x: 1996, y: 49, z: -3954 },
                { x: 1997, y: 49, z: -3987 },
                { x: 1997, y: 49, z: -3986 },
                { x: 1997, y: 49, z: -3978 },
                { x: 1997, y: 49, z: -3977 },
                { x: 1997, y: 49, z: -3963 },
                { x: 1997, y: 49, z: -3962 },
                { x: 1997, y: 49, z: -3954 },
                { x: 1997, y: 49, z: -3953 },
                { x: 1997, y: 56, z: -3934 },
                { x: 1998, y: 49, z: -3987 },
                { x: 1998, y: 49, z: -3977 },
                { x: 1998, y: 49, z: -3963 },
                { x: 1998, y: 49, z: -3953 },
                { x: 1998, y: 56, z: -3934 },
                { x: 1999, y: 49, z: -3988 },
                { x: 1999, y: 49, z: -3987 },
                { x: 1999, y: 49, z: -3977 },
                { x: 1999, y: 49, z: -3976 },
                { x: 1999, y: 49, z: -3964 },
                { x: 1999, y: 49, z: -3963 },
                { x: 1999, y: 49, z: -3953 },
                { x: 1999, y: 49, z: -3952 },
                { x: 1999, y: 57, z: -3922 },
                { x: 1999, y: 57, z: -3921 },
                { x: 1999, y: 57, z: -3920 },
                { x: 2000, y: 49, z: -3994 },
                { x: 2000, y: 49, z: -3992 },
                { x: 2000, y: 49, z: -3988 },
                { x: 2000, y: 49, z: -3976 },
                { x: 2000, y: 49, z: -3964 },
                { x: 2000, y: 49, z: -3952 },
                { x: 2000, y: 50, z: -3945 },
                { x: 2000, y: 50, z: -3944 },
                { x: 2000, y: 52, z: -3993 },
                { x: 2000, y: 57, z: -3931 },
                { x: 2000, y: 57, z: -3930 },
                { x: 2000, y: 57, z: -3924 },
                { x: 2000, y: 57, z: -3923 },
                { x: 2000, y: 57, z: -3922 },
                { x: 2000, y: 57, z: -3920 },
                { x: 2000, y: 57, z: -3919 },
                { x: 2000, y: 57, z: -3918 },
                { x: 2001, y: 49, z: -3976 },
                { x: 2001, y: 49, z: -3975 },
                { x: 2001, y: 49, z: -3965 },
                { x: 2001, y: 49, z: -3964 },
                { x: 2001, y: 57, z: -3930 },
                { x: 2001, y: 57, z: -3929 },
                { x: 2001, y: 57, z: -3928 },
                { x: 2001, y: 57, z: -3926 },
                { x: 2001, y: 57, z: -3925 },
                { x: 2001, y: 57, z: -3924 },
                { x: 2001, y: 57, z: -3918 },
                { x: 2001, y: 57, z: -3917 },
                { x: 2001, y: 57, z: -3916 },
                { x: 2002, y: 49, z: -3975 },
                { x: 2002, y: 49, z: -3965 },
                { x: 2002, y: 57, z: -3928 },
                { x: 2002, y: 57, z: -3927 },
                { x: 2002, y: 57, z: -3926 },
                { x: 2002, y: 57, z: -3916 },
                { x: 2002, y: 57, z: -3915 },
                { x: 2002, y: 57, z: -3914 },
                { x: 2003, y: 49, z: -3975 },
                { x: 2003, y: 49, z: -3974 },
                { x: 2003, y: 49, z: -3966 },
                { x: 2003, y: 49, z: -3965 },
                { x: 2004, y: 49, z: -3974 },
                { x: 2004, y: 49, z: -3973 },
                { x: 2004, y: 49, z: -3967 },
                { x: 2004, y: 49, z: -3966 },
                { x: 2005, y: 49, z: -3973 },
                { x: 2005, y: 49, z: -3972 },
                { x: 2005, y: 49, z: -3971 },
                { x: 2005, y: 49, z: -3969 },
                { x: 2005, y: 49, z: -3968 },
                { x: 2005, y: 49, z: -3967 },
                { x: 2006, y: 49, z: -3971 },
                { x: 2006, y: 49, z: -3970 },
                { x: 2006, y: 49, z: -3969 }
            ]
        }
    }
};

//start up the world
world.afterEvents.playerSpawn.subscribe(evd=>{
    if (!evd.initialSpawn) return;
    const player = evd.player;
    if (worldOwnerName === null) {
        worldOwnerName = player.name;
    }
    getPlayerBestTimes(player);
    // If < 2 players total, delete all ticking areas
    const totalPlayers = world.getPlayers().length;
    if (totalPlayers < 2) {
        deleteAllTickingAreas();
    }
    hub(player);
    player.setGameMode("Survival");
    player.sendMessage('§8-------------------------------');
    player.sendMessage('§3Welcome to §bBridgeCore!');
    player.sendMessage('§3  - Creator: §bhippox1');
    player.sendMessage('§3  - Collaborator: §bpersephone');
    player.sendMessage('§3  - Version: §bRelease 1.0');
    player.sendMessage('§3  - Community: §bdiscord.gg/XNfSKUs38D');
    player.sendMessage('§8-------------------------------');
    player.sendMessage('§7  - /commands for more information');
    system.runTimeout(() => {
        player.sendMessage(`§7[§a+§7] §a${player.name}`);
    }, 5);
});

// Player leave event - clear blocks placed by non-owner players
world.afterEvents.playerLeave.subscribe(evd => {
    const player = evd.playerName;
    
    // Only clear blocks if leaving player is NOT the owner
    if (player !== worldOwnerName) {
        clearPlacedBlocksForPlayer(player);
        deletePlayerTickingArea(player);
    }
});

world.afterEvents.pressurePlatePush.subscribe(evd => {
    const player = evd.source;
    const block = evd.block;
    if (player.hasTag('run')) {
        if (block.typeId === "minecraft:light_weighted_pressure_plate") {
            stopRun(player);
        }
    }
});

// no break
world.beforeEvents.playerBreakBlock.subscribe(evd=>{
    const player = evd.player;
    if (player.hasTag('buildmode')) return;
    if (player.hasTag("hub") || player.hasTag('freestyle') || player.hasTag('speedbridge') || player.hasTag('bedwarsrush') || player.hasTag('parkour') || player.hasTag('gauntlet')) {
        evd.cancel = true;
    }
});

function deleteAllTagsAndAddHub(entity) {
    const tags = entity.getTags();
    const tagsToPreserve = ['rcps', 'blockamount', 'timer'];
    
    tags.forEach(tag => {
        if (!tagsToPreserve.includes(tag)) {
            entity.removeTag(tag);
        }
    });
    entity.addTag("hub");
}

// hub and lobby commands
function hub(player) {
    const s = getStateFor(player);
    const s2 = getPatternRunState(player);
    if (s2.timerId && s2.active) {
        system.clearRun(s2.timerId);
        s2.timerId = null;
    }
    s2.active = false;
    s2.startTime = null;
    s.gmc = false;
    s.flymode = false;
    player.runCommand('ability @s mayfly false');
    if (s.active && s.timerId) {
        system.clearRun(s.timerId);
        s.timerId = null;
        s.active = false;
    }
    player.runCommand("clear @s");
    player.runCommand("effect @s clear");
    // Delete only this player's ticking area (not all ticking areas)
    deletePlayerTickingArea(player.name);
    deleteAllTagsAndAddHub(player);
    player.setGameMode("Survival");
    player.teleport({ x: 0.5, y: 50, z: 0.5 }, {facingLocation: { x: 0.5, y: 50, z: 1.5}});
    system.runTimeout(() => {
        player.runCommand('replaceitem entity @s slot.hotbar 4 book 1');
        player.playSound("random.levelup");
    }, 3);
}

/**
 * @param {Player} player
 */
const warpToHub = (player) => {
    hub(player);
    player.sendMessage("§aTeleported to the hub!");
};

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
    customCommandRegistry.registerCommand(
        {
            name: "server:hub",
            description: "Teleports you to the hub",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: true,
        },
        ({ sourceEntity: player }) => {
            if (!(player instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "§cOnly players can use this command" };
            }
        system.run(() => warpToHub(player));
        return { status: CustomCommandStatus.Success };
        }
    );
    customCommandRegistry.registerCommand(
        {
            name: "server:lobby",
            description: "Teleports you to the lobby",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: true,
        },
        ({ sourceEntity: player }) => {
            if (!(player instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "§cOnly players can use this command" };
            }
        system.run(() => warpToHub(player));
        return { status: CustomCommandStatus.Success };
        }
    );
    customCommandRegistry.registerCommand(
        {
            name: "server:tags",
            description: "Shows all tags currently applied to you",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: true,
        },
        ({ sourceEntity: player }) => {
            if (!(player instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "§cOnly players can use this command" };
            }
            const tags = player.getTags ? player.getTags() : [];
            const formatted = tags.length ? tags.join(", ") : "No tags found";
            player.sendMessage(`§aYour tags: §r${formatted}`);
            return { status: CustomCommandStatus.Success };
        }
    );
    customCommandRegistry.registerCommand(
        {
            name: "server:reset",
            description: "Resets all your best times",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: true,
        },
        ({ sourceEntity: player }) => {
            if (!(player instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "§cOnly players can use this command" };
            }
            resetAllBestTimes(player);
            return { status: CustomCommandStatus.Success };
        }
    );
    customCommandRegistry.registerCommand(
        {
            name: "server:admin",
            description: "Toggle admin status (for building/breaking blocks and such)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: true,
        },
        ({ sourceEntity: player }) => {
            if (!(player instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "§cOnly players can use this command" };
            }
            
            // Only world owner can use admin command
            if (player.name !== worldOwnerName) {
                return { status: CustomCommandStatus.Failure, message: "§cOnly the world owner can use this command" };
            }
            
            // Execute in proper system context
            system.run(() => {
                // Clear any active timer
                const s = getStateFor(player);
                if (s.timerId) {
                    system.clearRun(s.timerId);
                    s.timerId = null;
                    s.active = false;
                }
                
                if (player.hasTag('admin')) {
                    // If player has admin tag, remove it
                    player.removeTag('admin');
                    player.sendMessage("§c§lAdmin mode disabled!");
                    player.runCommand('clear @s');
                    player.runCommand('effect @s clear');
                } else {
                    // If player doesn't have admin tag, remove all tags and add admin
                    const tags = player.getTags ? player.getTags() : [];
                    for (let i = 0; i < tags.length; i++) {
                        try {
                            player.removeTag(tags[i]);
                        } catch (err) {
                            // Ignore tag removal errors
                        }
                    }
                    player.addTag('admin');
                    player.sendMessage("§a§lAdmin mode enabled!");
                    player.runCommand('clear @s');
                    player.runCommand('give @p orange_dye 1');
                    player.runCommand('give @p yellow_dye 1');
                    player.runCommand('effect @s clear');
                }
            });
            
            return { status: CustomCommandStatus.Success };
        }
    );
        customCommandRegistry.registerCommand(
        {
            name: "server:commands",
            description: "Shows all available commands",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: true,
        },
        ({ sourceEntity: player }) => {
            if (!(player instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "Only players can use this command" };
            }
            
            player.sendMessage('§8-------------------------------');
            player.sendMessage('§b§lAvailable Commands:');
            player.sendMessage('§8-------------------------------');
            player.sendMessage('/hub §7- Teleport to the hub');
            player.sendMessage('/lobby §7- Teleport to the lobby');
            //player.sendMessage('/changemode §7- Change your mode (not in freestyle)');
            player.sendMessage('/reset §7- Reset all your best times');
            player.sendMessage('/commands §7- Show this help message');
            player.sendMessage('§8-------------------------------');
            player.sendMessage('§b§lNotes:');
            player.sendMessage('§7- The map is multiplayer compatible');
            player.sendMessage('§7- /admin for destroying missplaced blocks and such (world owner only)');
            player.sendMessage('§8-------------------------------');
            
            return { status: CustomCommandStatus.Success };
        }
    );
    customCommandRegistry.registerCommand(
        {
            name: "server:areas",
            description: "Shows all existing ticking areas",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: true,
        },
        ({ sourceEntity: player }) => {
            if (!(player instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "§cOnly players can use this command" };
            }
            
            player.sendMessage('§8-------------------------------');
            player.sendMessage('§b§lActive Ticking Areas:');
            player.sendMessage('§8-------------------------------');
            
            if (playerTickingAreas.size === 0) {
                player.sendMessage('§7No active ticking areas');
            } else {
                for (const [playerName, areaName] of playerTickingAreas) {
                    player.sendMessage(`§b${playerName}: §r${areaName}`);
                }
            }
            
            player.sendMessage('§8-------------------------------');
            
            return { status: CustomCommandStatus.Success };
        }
    );
});

const forms = {};

function buildForms() {
    for (const [key, definition] of Object.entries(formDefinitions)) {
        const form = new ActionFormData();
        actionFormDataInfo(form, definition.buttons, definition.title);
        forms[key] = form;
    }
}

system.run(() => {
    buildForms();
});

function actionFormDataInfo(formId, buttons, title) {
    formId.title(title);
    for (let i = 0; i < buttons.length; i++) {
        formId.button(buttons[i].name, buttons[i].texture);
    }
}

function createModeBestTimeButtonText(modeName, bestTimeData) {
    let bestTime = null;
    if (bestTimeData && Object.keys(bestTimeData).length > 0) {
        bestTime = Math.min(...Object.values(bestTimeData));
    }
    
    const padding = ";".repeat(Math.max(0, 32 - modeName.length));
    const hoverText = bestTime !== null 
        ? `Best: ${bestTime.toFixed(2)}s`
        : "No records";
    
    return modeName + padding + hoverText;
}

const formDefinitions = {
    navigator: {
        title: "dui_navigation_form;Navigator",
        buttons: [
            { name: "Gamemodes", texture: "textures/dui/images/navigator/gamemodes.png" },
            { name: "Settings", texture: "textures/dui/images/navigator/settings.png" },
            { name: "Stats", texture: "textures/dui/images/navigator/stats.png" },
            { name: "Cosmetics", texture: "textures/dui/images/navigator/cosmetics.png" }
        ]
    },
    gamemodes: {
        title: "dui_gamemodes_form;Gamemodes",
        buttons: [
            { name: "Freestyle", texture: "textures/dui/images/gamemodes/freestyle.png" },
            { name: "Speedbridge", texture: "textures/dui/images/gamemodes/speedbridge.png" },
            { name: "Bedwars Rush", texture: "textures/dui/images/gamemodes/rush.png" },
            { name: "Gauntlet", texture: "textures/dui/images/gamemodes/gauntlet.png" },
            { name: "Parkour", texture: "textures/dui/images/gamemodes/parkour.png" }            
        ]
    },
    freestyle: {
        title: "dui_navigation_form;Freestyle",
        buttons: [
            { name: "No Score", texture: "textures/dui/images/gamemodes/freestyle/noscore.png" },
            { name: "Pattern", texture: "textures/dui/images/gamemodes/freestyle/pattern.png" },
            { name: "Custom", texture: "textures/dui/images/gamemodes/freestyle/custom.png" },
            { name: "1 Block", texture: "textures/dui/images/gamemodes/freestyle/1block.png" }
        ]
    },
};

function handleSettings(player) {
    const isPatternLearning = player.hasTag("patternlearning");
    const isCustomIsland = player.hasTag("customisland");
    
    const settingsForm = new ModalFormData()
        .title("dui_modal_form;Settings")
        .dropdown("Time", ["Day", "Noon", "Sunset", "Night", "Midnight"])
        .slider("Speed Effect", 0, 5)
        .slider("Slowness Effect", 0, 5);
    
    // If pattern learning mode, show only Timer option
    if (isPatternLearning) {
        settingsForm.toggle("Timer", { defaultValue: player.hasTag("timer") });
    } else {
        // Otherwise show the normal options
        settingsForm.toggle("Blocks per Second", { defaultValue: player.hasTag("rcps") })
                   .toggle("Block Placed", { defaultValue: player.hasTag("blockamount") });
        
        // Only add Build Mode toggle if player is in customisland mode
        if (isCustomIsland) {
            settingsForm.toggle("Build Mode", { defaultValue: player.hasTag("buildmode") });
        }
    }
    
    settingsForm.show(player).then(r => {
        if (r.canceled) return;        
        player.sendMessage("§3Settings updated!");        
        
        // Time command
        const timeCmds = ["time set 1000", "time set 6000", "time set 12000", "time set 15000", "time set 18000"];
        player.runCommand(timeCmds[r.formValues[0]]);        
        
        // Speed effect
        const speedLevel = r.formValues[1];
        if (speedLevel > 0) {
            player.addEffect("speed", 999999, { amplifier: speedLevel - 1, showParticles: false });
        } else {
            player.removeEffect("speed");
        }        
        
        // Slowness effect
        const slownessLevel = r.formValues[2];
        if (slownessLevel > 0) {
            player.addEffect("slowness", 999999, { amplifier: slownessLevel - 1, showParticles: false });
        } else {
            player.removeEffect("slowness");
        }        
        
        // Handle toggles based on mode
        if (isPatternLearning) {
            // Pattern learning mode: only Timer toggle
            if (r.formValues[3]) player.addTag("timer"); 
            else player.removeTag("timer");
        } else {
            // Normal mode: Blocks per Second and Block Placed toggles
            if (r.formValues[3]) player.addTag("rcps"); 
            else player.removeTag("rcps");
            
            if (r.formValues[4]) player.addTag("blockamount"); 
            else player.removeTag("blockamount");
            
            // Build Mode toggle only for customisland players
            if (isCustomIsland) {
                if (r.formValues[5]) player.addTag("buildmode"); 
                else player.removeTag("buildmode");
            }
        }
    });
}

function clearPlayerArea(player) {
    if (!player.hasTag('admin')) return;
    const playerLoc = player.location;
    const centerX = Math.floor(playerLoc.x);
    const centerY = Math.floor(playerLoc.y);
    const centerZ = Math.floor(playerLoc.z);
    
    const dim = world.getDimension("overworld");
    
    // 5x5x5 cube: ±2 from center
    for (let x = centerX - 4; x <= centerX + 4; x++) {
        for (let y = centerY - 4; y <= centerY + 4; y++) {
            for (let z = centerZ - 4; z <= centerZ + 4; z++) {
                dim.setBlockType({ x, y, z }, "minecraft:air");
            }
        }
    }
}

function toggleGameMode(player) {
    const s = getStateFor(player);
    if (!s.gmc) {
        player.setGameMode("Creative");
        s.gmc = true;
        player.sendMessage("§bGamemode: §rCreative");
    } else {
        player.setGameMode("Survival");
        s.gmc = false;
        player.sendMessage("§bGamemode: §rSurvival");
    }
}

function toggleFlyMode(player) {
    try {
        const state = getStateFor(player);
        if (state.flymode === false) {
            // Enable fly mode
            player.runCommand(`ability @s mayfly true`);
            player.sendMessage("§bFly mode: §rEnabled");
            state.flymode = true;
        } else {
            // Disable fly mode
            player.runCommand(`ability @s mayfly false`);
            player.sendMessage("§bFly mode: §rDisabled");
            state.flymode = false;
        }
    } catch (err) {
        console.warn(`Failed to toggle fly mode for ${player.name}:`, err);
    }
}

function toggleEditMode(player) {
    const s = getStateFor(player);
    if (!player.hasTag("buildmode")) {
        player.addTag("buildmode");
        player.addTag("patternlearning");
        player.runCommand('clear @s');
        player.runCommand('replaceitem entity @s slot.hotbar 5 pink_dye 1');
        player.runCommand(`replaceitem entity @s slot.hotbar 0 ${detectorBlockType} 1`);
        s.flymode = true;
        s.gmc = true;
        player.runCommand(`ability @s mayfly true`);
        player.setGameMode("Creative");
        player.sendMessage('§8-------------------------------');
        player.sendMessage("§bEdit mode: §rEnabled");
        player.sendMessage("You can now §bEdit the pattern");
        player.sendMessage("Use §bDetector Blocks §rto track your pattern");
        player.sendMessage('§8-------------------------------');
        player.teleport(coords.freestyle.patternLearning.pos);
        
        // Replace trackers to detectors based on dynamic property list
        system.runTimeout(() => {
            replaceTrackersWithDetectors(player);
        }, 5);
    } else {
        player.removeTag("buildmode");
        player.sendMessage("§bEdit mode: §rDisabled");
        giveItem(player);
        s.flymode = false;
        s.gmc = false;
        player.runCommand(`ability @s mayfly false`);
        player.setGameMode("Survival");
        player.teleport(coords.freestyle.patternLearning.pos);
        
        // Replace detectors back to trackers
        system.runTimeout(() => {
            replaceDetectorsWithTrackers(player);
        }, 5);
    }
}

const itemUseHandlers = {
    "minecraft:book": handleBook,
    "minecraft:stick": collectGauntletTrackerCoords,
    "minecraft:red_dye": handleSettings,
    "minecraft:orange_dye": toggleGameMode,
    "minecraft:yellow_dye": toggleFlyMode,
    "minecraft:pink_dye": toggleEditMode,
    "minecraft:blaze_rod": clearPlayerArea,
}

world.afterEvents.itemUse.subscribe((event) => {
    const { source, itemStack } = event;
    const handler = itemUseHandlers[itemStack.typeId];
    if (handler) handler(source, itemStack, event);
});

function handleBook(player) {
    player.playSound('random.click');
    forms.navigator.show(player).then(r => {
        if (r.canceled) return;
        switch (r.selection) {
            case 0: // Gamemodes
                hadleGamemodes(player);
            break;
            case 1: // Settings
                handleSettings(player);
            break;
            case 2: // Stats
                const s = getStateFor(player);
                player.sendMessage('§8-------------------------------');
                player.sendMessage(`§b§l${player.name}'s Stats:`);
                player.sendMessage('§8-------------------------------');
                
                // Speedbridge
                if (Object.keys(s.bestTimes.speedbridge).length > 0) {
                    player.sendMessage('§b§lSpeedbridge:');
                    for (const [variant, time] of Object.entries(s.bestTimes.speedbridge)) {
                        player.sendMessage(`  §b${variant}: §r${time.toFixed(2)} §7(${time.toFixed(3)})`);
                    }
                } else {
                    player.sendMessage('§b§lSpeedbridge: §r§7No records');
                }
                
                // Parkour
                if (Object.keys(s.bestTimes.parkour).length > 0) {
                    player.sendMessage('§b§lParkour:');
                    for (const [variant, time] of Object.entries(s.bestTimes.parkour)) {
                        player.sendMessage(`  §b${variant}: §r${time.toFixed(2)} §7(${time.toFixed(3)})`);
                    }
                } else {
                    player.sendMessage('§b§lParkour: §r§7No records');
                }
                
                // Bedwars Rush
                if (Object.keys(s.bestTimes.bedwarsRush).length > 0) {
                    player.sendMessage('§b§lBedwars Rush:');
                    for (const [variant, time] of Object.entries(s.bestTimes.bedwarsRush)) {
                        player.sendMessage(`  §b${variant}: §r${time.toFixed(2)} §7(${time.toFixed(3)})`);
                    }
                } else {
                    player.sendMessage('§b§lBedwars Rush: §r§7No records');
                }

                // Gauntlet
                if (Object.keys(s.bestTimes.gauntlet).length > 0) {
                    player.sendMessage('§b§lGauntlet:');
                    for (const [variant, time] of Object.entries(s.bestTimes.gauntlet)) {
                        player.sendMessage(`  §b${variant}: §r${time.toFixed(2)} §7(${time.toFixed(3)})`);
                    }
                } else {
                    player.sendMessage('§b§lGauntlet: §r§7No records');
                }
                
                player.sendMessage('§8-------------------------------');
            break;
            case 3: // Cosmetics
                player.sendMessage("§bCosmetics coming soon!");
            break;
        }
    });
}

function hadleGamemodes(player) {
    forms.gamemodes.show(player).then(r => {
        if (r.canceled) return;
        switch (r.selection) {
            case 0: // Freestyle
                handleFreestyle(player);
            break;
            case 1: // Speedbridge
                handleSpeedbridge(player);
            break;
            case 2: // Bedwars Rush
                handleBedwarsRush(player);
            break;
            case 3: // Gauntlet
                handleGauntlet(player);
            break;
            case 4: // Parkour
                handleParkour(player);
            break;
        }
    });
}

function handleFreestyle(player) {
    forms.freestyle.show(player).then(r => {
        if (r.canceled) return;
        switch (r.selection) {
            case 0: // No Score
                handleNoScore(player);
            break;
            case 1: // pattern learning
                handlePatternLearning(player);
            break;
            case 2: // custom island
                handleCustomIsland(player);
            break;
            case 3: // 1 block
                handleOneBlock(player);
            break;
        }
    });
}

function handleNoScore(player) {
    player.removeTag('hub');
    player.addTag('freestyle');
    player.addTag('noScore');
    // Always create ticking area for noscore
    const tickingAreaPos = coords.freestyle.noScore.tickingArea;
    createTickingArea(tickingAreaPos, player.name);
    player.teleport(coords.freestyle.noScore.pos);
    giveItem(player);
    clearPlacedBlocksForPlayer(player);
    totalBlocks.set(player, 0);
}

function handlePatternLearning(player) {
    // Only world owner can access pattern learning mode
    if (player.name !== worldOwnerName) {
        player.sendMessage("§cOnly the World Owner can access Pattern Learning!");
        return;
    }
    player.removeTag('hub');
    player.addTag('freestyle');
    player.addTag('patternlearning');
    
    // Get stored detector coords
    const coords_list = getPatternCoordsForPlayer(player);
    
    // Always create ticking area for pattern learning
    const tickingAreaPos = coords.freestyle.patternLearning.tickingArea;
    createTickingArea(tickingAreaPos, player.name);
    
    // Teleport to position
    player.teleport(coords.freestyle.patternLearning.pos);
    giveItem(player);
    clearPlacedBlocksForPlayer(player);
    totalBlocks.set(player, 0);
    
    // Replace all trackers to detectors based on coords list (even if empty)
    system.runTimeout(() => {
        replaceDetectorsWithTrackers(player);
        // Check if pattern coords list is empty and send message
        if (!coords_list || coords_list.length === 0) {
            player.sendMessage('§8-------------------------------');
            player.sendMessage('§b§lNo pattern found!');
            player.sendMessage('§7Use §bEdit Pattern §7to create a pattern');
            player.sendMessage('§8-------------------------------');
        }
    }, 5);
}

function handleCustomIsland(player) {
    player.removeTag('hub');
    player.addTag('freestyle');
    player.addTag('customisland');
    // Always create ticking area for custom island
    const tickingAreaPos = coords.freestyle.customIsland.tickingArea;
    createTickingArea(tickingAreaPos, player.name);
    player.teleport(coords.freestyle.customIsland.pos);
    giveItem(player);
    clearPlacedBlocksForPlayer(player);
    totalBlocks.set(player, 0);
}

function handleOneBlock(player) {
    const dim = world.getDimension("overworld");
    system.runTimeout(() => {
        dim.runCommand(`setblock 2000 49 1000 bedrock`);
    }, 2);
    player.removeTag('hub');
    player.addTag('freestyle');
    player.addTag('oneblock');
    // Always create ticking area for one block
    const tickingAreaPos = coords.freestyle.oneBlock.tickingArea;
    createTickingArea(tickingAreaPos, player.name);
    player.teleport(coords.freestyle.oneBlock.pos);
    giveItem(player);
    clearPlacedBlocksForPlayer(player);
    totalBlocks.set(player, 0);
}

function handleSpeedbridge(player) {
    const s = getStateFor(player);
    const modes = ['short', 'normal', 'long', 'stackUp', 'shortDiagonal', 'diagonal'];
    
    const speedbridgeForm = new ActionFormData()
        .title("dui_gamemodes_form;Speedbridge");
    
    // Add buttons with best times for each mode
    for (const mode of modes) {
        const modeData = s.bestTimes.speedbridge[mode];
        let bestTimeText = mode.charAt(0).toUpperCase() + mode.slice(1);
        const padding = ";".repeat(Math.max(0, 32 - bestTimeText.length));
        const hoverText = modeData !== undefined 
            ? `Best Time: ${modeData.toFixed(2)}s`
            : "No record";
        speedbridgeForm.button(bestTimeText + padding + hoverText, "textures/dui/images/gamemodes/speedbridge.png");
    }
    
    speedbridgeForm.show(player).then(r => {
        if (r.canceled) return;
        
        player.removeTag('hub');
        player.addTag('speedbridge');
        
        const selectedMode = modes[r.selection];
        player.addTag(`speedbridge_${selectedMode}`);
        
        const modeCoords = coords.speedbridge[selectedMode];
        
        const availablePositions = [];
        for (let i = 1; i <= 5; i++) {
            const positionTag = `speedbridge_${selectedMode}_no${i}`;
            const isOccupied = world.getPlayers().some(p => 
                p.name !== player.name && p.hasTag(positionTag)
            );
            if (!isOccupied) {
                availablePositions.push(i);
            }
        }
        
        if (availablePositions.length === 0) {
            player.sendMessage(`§a${selectedMode.toUpperCase()} mode is full!`);
            player.removeTag('speedbridge');
            player.removeTag(`speedbridge_${selectedMode}`);
            return;
        }
        
        const randomIndex = Math.floor(Math.random() * availablePositions.length);
        const selectedPosition = availablePositions[randomIndex];
        const positionTag = `speedbridge_${selectedMode}_no${selectedPosition}`;
        
        player.addTag(positionTag);
        player.addTag('run');
        
        const posData = modeCoords[`no${selectedPosition}`];
        player.teleport(posData.pos, { facingLocation: posData.facing });
        player.runCommand('clear @s');
        system.runTimeout(() => {
            giveItem(player);
            clearPlacedBlocksForPlayer(player);
        }, 20);
        
        const playersInMode = countPlayersInSpeedBridgeMode(selectedMode);
        if (playersInMode === 1) {
            const tickingAreaPos = modeCoords.tickingArea;
            createTickingArea(tickingAreaPos, player.name);
        }
        player.sendMessage(`§b${player.name}§r has joined §b${selectedMode}§r at island §b${selectedPosition}`);
    });
}

function handleBedwarsRush(player) {
    const s = getStateFor(player);
    const maps = ['city', 'paradise', 'citadel', 'luck', 'village', 'wasteland', 'nether', 'temple'];
    
    const bedwarsForm = new ActionFormData()
        .title("dui_gamemodes_form;Bedwars Rush");
    
    for (const map of maps) {
        const mapData = s.bestTimes.bedwarsRush[map];
        let mapText = map.charAt(0).toUpperCase() + map.slice(1);
        const padding = ";".repeat(Math.max(0, 32 - mapText.length));
        const hoverText = mapData !== undefined 
            ? `Best Time: ${mapData.toFixed(2)}s`
            : "No record";
        bedwarsForm.button(mapText + padding + hoverText, `textures/dui/images/gamemodes/rush/${map}.png`);
    }
    
    bedwarsForm.show(player).then(r => {
        if (r.canceled) return;
        
        player.removeTag('hub');
        player.addTag('run');
        player.addTag('bedwarsrush');
        
        const selectedMap = maps[r.selection];
        const mapTag = `bedwarsrush_${selectedMap}`;
        
        const isOccupied = world.getPlayers().some(p => 
            p.name !== player.name && p.hasTag(mapTag)
        );
        
        if (isOccupied) {
            player.sendMessage(`§a${selectedMap.toUpperCase()} map is full!`);
            return;
        }
        
        player.addTag(mapTag);
        
        const mapCoords = coords.rush[selectedMap];
        player.teleport(mapCoords.pos, { facingLocation: mapCoords.facing });
        player.runCommand('clear @s');
        system.runTimeout(() => {
            giveItem(player);
            clearPlacedBlocksForPlayer(player);
        }, 20);
        
        const tickingAreaPos = mapCoords.tickingArea;
        createTickingArea(tickingAreaPos, player.name);
        player.sendMessage(`§b${player.name}§r has joined §b${selectedMap}§r`);
    });
}

function handleParkour(player) {
    const s = getStateFor(player);
    const courses = Array.from({ length: 10 }, (_, i) => `pcourse${i + 1}`);
    
    const parkourForm = new ActionFormData()
        .title("dui_gamemodes_form;Parkour");
    
    for (let i = 0; i < courses.length; i++) {
        const course = courses[i];
        const courseData = s.bestTimes.parkour[course];
        let courseText = `Course ${i + 1}`;
        const padding = ";".repeat(Math.max(0, 32 - courseText.length));
        const hoverText = courseData !== undefined 
            ? `Best Time: ${courseData.toFixed(2)}s`
            : "No record";
        parkourForm.button(courseText + padding + hoverText, `textures/dui/images/gamemodes/parkour/course${i + 1}.png`);
    }
    
    parkourForm.show(player).then(r => {
        if (r.canceled) return;
        
        player.removeTag('hub');
        player.addTag('run');
        player.addTag('parkour');
        
        const selectedCourse = courses[r.selection];
        const courseTag = selectedCourse;
        
        const isOccupied = world.getPlayers().some(p => 
            p.name !== player.name && p.hasTag(courseTag)
        );
        
        if (isOccupied) {
            player.sendMessage(`§a${selectedCourse.toUpperCase()} is full!`);
            player.removeTag('parkour');
            return;
        }
        
        player.addTag(courseTag);
        
        const courseCoords = coords.parkour[selectedCourse];
        player.teleport(courseCoords.pos, { facingLocation: courseCoords.facing });
        player.runCommand('clear @s');
        system.runTimeout(() => {
            giveItem(player);
            clearPlacedBlocksForPlayer(player);
        }, 20);
        
        const tickingAreaPos = courseCoords.tickingArea;
        createTickingArea(tickingAreaPos, player.name);
        player.sendMessage(`§b${player.name}§r has joined §b${selectedCourse}§r`);
    });
}

function handleGauntlet(player) {
    const s = getStateFor(player);
    const courses = Array.from({ length: 10 }, (_, i) => `gcourse${i + 1}`);
    
    const gauntletForm = new ActionFormData()
        .title("dui_gamemodes_form;Gauntlet");
    
    for (let i = 0; i < courses.length; i++) {
        const course = courses[i];
        const courseData = s.bestTimes.gauntlet[course];
        let courseText = `Course ${i + 1}`;
        const padding = ";".repeat(Math.max(0, 32 - courseText.length));
        const hoverText = courseData !== undefined 
            ? `Best Time: ${courseData.toFixed(2)}s`
            : "No record";
        gauntletForm.button(courseText + padding + hoverText, `textures/dui/images/gamemodes/gauntlet/course${i + 1}.png`);
    }
    
    gauntletForm.show(player).then(r => {
        if (r.canceled) return;
        
        player.removeTag('hub');
        player.addTag('run');
        player.addTag('gauntlet');
        
        const selectedCourse = courses[r.selection];
        const courseTag = selectedCourse;
        
        const isOccupied = world.getPlayers().some(p => 
            p.name !== player.name && p.hasTag(courseTag)
        );
        
        if (isOccupied) {
            player.sendMessage(`§a${selectedCourse.toUpperCase()} is full!`);
            player.removeTag('gauntlet');
            return;
        }
        
        player.addTag(courseTag);
        
        const courseCoords = coords.gauntlet[selectedCourse];
        player.teleport(courseCoords.pos, { facingLocation: courseCoords.facing });
        player.runCommand('clear @s');
        system.runTimeout(() => {
            giveItem(player);
            clearPlacedBlocksForPlayer(player);
        }, 20);
        
        replaceTracker(player);
        
        const tickingAreaPos = courseCoords.tickingArea;
        createTickingArea(tickingAreaPos, player.name);
        player.sendMessage(`§b${player.name}§r has joined §b${selectedCourse}§r`);
    });
}