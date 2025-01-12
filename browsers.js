// Browser configurations with different profiles and extensions
const browsers = [
    {
        name: 'Chrome',
        versions: ['120.0.0.0', '119.0.0.0', '118.0.0.0'],
        platforms: ['Windows NT 10.0', 'Windows NT 11.0', 'Macintosh; Intel Mac OS X 10_15_7'],
        extensions: ['uBlock Origin', 'LastPass', 'Grammarly'],
        userAgent: (version, platform) => 
            `Mozilla/5.0 (${platform}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
    },
    {
        name: 'Firefox',
        versions: ['121.0', '120.0', '119.0'],
        platforms: ['Windows NT 10.0', 'Windows NT 11.0', 'X11; Ubuntu; Linux x86_64'],
        extensions: ['uBlock Origin', 'HTTPS Everywhere', 'Privacy Badger'],
        userAgent: (version, platform) => 
            `Mozilla/5.0 (${platform}; rv:${version}) Gecko/20100101 Firefox/${version}`
    },
    {
        name: 'Edge',
        versions: ['120.0.0.0', '119.0.0.0', '118.0.0.0'],
        platforms: ['Windows NT 10.0', 'Windows NT 11.0'],
        extensions: ['Microsoft Defender', 'Honey', 'AdBlock'],
        userAgent: (version, platform) => 
            `Mozilla/5.0 (${platform}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36 Edg/${version}`
    },
    {
        name: 'Safari',
        versions: ['17.1', '17.0', '16.6'],
        platforms: ['Macintosh; Intel Mac OS X 10_15_7', 'Macintosh; Intel Mac OS X 11_6_0'],
        extensions: ['1Password', 'DuckDuckGo Privacy', 'AdGuard'],
        userAgent: (version, platform) => 
            `Mozilla/5.0 (${platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`
    },
    {
        name: 'Opera',
        versions: ['103.0.0.0', '102.0.0.0', '101.0.0.0'],
        platforms: ['Windows NT 10.0', 'X11; Linux x86_64'],
        extensions: ['Opera VPN', 'Opera Ad Blocker', 'Flow'],
        userAgent: (version, platform) => 
            `Mozilla/5.0 (${platform}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36 OPR/${version}`
    }
];

// Generate random IP from common ranges
function generateRandomIP() {
    const ranges = [
        // Vodafone Ukraine
        ['176.36.0.0', '176.37.255.255'],
        ['176.38.0.0', '176.39.255.255'],
        // Kyivstar
        ['188.163.0.0', '188.163.255.255'],
        ['178.92.0.0', '178.93.255.255'],
        // Lifecell
        ['93.74.0.0', '93.75.255.255'],
    ];
    
    const range = getRandomElement(ranges);
    const start = range[0].split('.').map(Number);
    const end = range[1].split('.').map(Number);
    
    const ip = start.map((octet, i) => {
        const min = octet;
        const max = end[i];
        return Math.floor(Math.random() * (max - min + 1)) + min;
    });
    
    return ip.join('.');
}

function getRandomElement(array) {
    return array[Math.floor(Math.random() * array.length)];
}

// Generate random color depth and screen resolution
function generateScreenParams() {
    const colorDepths = [24, 30, 48];
    const resolutions = [
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 },
        { width: 1366, height: 768 },
        { width: 1536, height: 864 },
        { width: 1440, height: 900 }
    ];
    
    return {
        colorDepth: getRandomElement(colorDepths),
        resolution: getRandomElement(resolutions)
    };
}

// Generate random timezone offset for Ukraine (UTC+2 or UTC+3 for summer time)
function generateTimezoneOffset() {
    return getRandomElement([-120, -180]);
}

function generateBrowserProfile() {
    const browser = getRandomElement(browsers);
    const version = getRandomElement(browser.versions);
    const platform = getRandomElement(browser.platforms);
    
    const numExtensions = Math.floor(Math.random() * 2) + 2;
    const extensions = [...browser.extensions]
        .sort(() => 0.5 - Math.random())
        .slice(0, numExtensions);
    
    const userAgent = browser.userAgent(version, platform);
    
    const viewports = [
        { width: 1920, height: 1080 },
        { width: 1366, height: 768 },
        { width: 1536, height: 864 },
        { width: 1440, height: 900 },
        { width: 1280, height: 720 }
    ];
    const viewport = getRandomElement(viewports);
    
    const screenParams = generateScreenParams();
    const ip = generateRandomIP();
    const timezoneOffset = generateTimezoneOffset();
    
    return {
        name: browser.name,
        version,
        platform,
        extensions,
        userAgent,
        viewport,
        ip,
        screenParams,
        timezoneOffset,
        headers: {
            'User-Agent': userAgent,
            'Sec-Ch-Ua': `"${browser.name}";v="${version}", "Not=A?Brand";v="99"`,
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': platform.split(';')[0].trim(),
            'X-Forwarded-For': ip,
            'X-Real-IP': ip
        }
    };
}

export function getRandomBrowserProfile() {
    return generateBrowserProfile();
}