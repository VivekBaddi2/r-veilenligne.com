interface AlarmPreferences {
	time: string;
	sound: string;
	volume: number;
	snooze: number;
	recentTimes: string[];
}

interface StoredAudio {
	blob: Blob;
	name: string;
}

interface BundledSound {
	id: string;
	label: string;
	src: string;
}

const bundledSoundFiles = import.meta.glob<string>(
	'../assets/sounds/*.{mp3,ogg,wav,m4a,aac,flac}',
	{ eager: true, query: '?url', import: 'default' },
);
const bundledSounds: BundledSound[] = Object.entries(bundledSoundFiles).map(([path, src]) => {
	const filename = path.split('/').pop() ?? path;
	const label = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
	return { id: `bundled:${path}`, label, src };
});

const storageKey = 'reveil-en-ligne-preferences';
const databaseName = 'reveil-en-ligne-audio';
const audioStoreName = 'music';
const alarmForm = document.querySelector<HTMLFormElement>('#alarm-form');
const timeInput = document.querySelector<HTMLInputElement>('#alarm-time');
const soundInput = document.querySelector<HTMLSelectElement>('#alarm-sound');
const audioFileInput = document.querySelector<HTMLInputElement>('#alarm-file');
const selectedFileLabel = document.querySelector<HTMLElement>('#selected-file');
const alarmAudio = document.querySelector<HTMLAudioElement>('#alarm-audio');
const volumeInput = document.querySelector<HTMLInputElement>('#alarm-volume');
const snoozeInput = document.querySelector<HTMLSelectElement>('#snooze-duration');
const volumeOutput = document.querySelector<HTMLOutputElement>('#volume-value');
const startLabel = document.querySelector<HTMLElement>('#start-label');
const statusMessage = document.querySelector<HTMLElement>('#alarm-status');
const countdownPanel = document.querySelector<HTMLElement>('#alarm-countdown');
const countdownValue = document.querySelector<HTMLTimeElement>('#countdown-value');
const alarmTarget = document.querySelector<HTMLElement>('#alarm-target');
const ringingPanel = document.querySelector<HTMLElement>('#alarm-ringing');
const snoozeLabel = document.querySelector<HTMLElement>('#snooze-label');
const recentTimesSection = document.querySelector<HTMLElement>('#recent-times');
const recentTimesList = document.querySelector<HTMLElement>('#recent-times-list');
const alarmCard = document.querySelector<HTMLElement>('.alarm-card');

let targetTime: number | null = null;
let countdownInterval: number | undefined;
let previewTimeout: number | undefined;
let wakeLock: WakeLockSentinel | null = null;
let ringing = false;
let recentTimes: string[] = [];
let selectedSound = '';
let customAudioUrl: string | null = null;
let databasePromise: Promise<IDBDatabase> | null = null;

function setStatus(message: string) {
	statusMessage?.replaceChildren(document.createTextNode(message));
}

function formatTime(date: Date) {
	return new Intl.DateTimeFormat('fr-FR', {
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

function writeTimeToInput(date: Date) {
	if (!timeInput) return;
	timeInput.value = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function updateClock() {
	const now = new Date();
	const clock = document.querySelector<HTMLTimeElement>('#local-clock');
	const date = document.querySelector<HTMLElement>('#local-date');

	if (clock) {
		clock.dateTime = now.toISOString();
		clock.textContent = new Intl.DateTimeFormat('fr-FR', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		}).format(now);
	}

	if (date) {
		date.textContent = new Intl.DateTimeFormat('fr-FR', {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			year: 'numeric',
		}).format(now);
	}
}

function isAlarmPreferences(value: unknown): value is AlarmPreferences {
	if (!value || typeof value !== 'object') return false;
	const preferences = value as Partial<AlarmPreferences>;
	return (
		typeof preferences.time === 'string' &&
		/^\d{2}:\d{2}$/.test(preferences.time) &&
		typeof preferences.sound === 'string' &&
		typeof preferences.volume === 'number' &&
		Number.isFinite(preferences.volume) &&
		typeof preferences.snooze === 'number' &&
		[5, 10, 15].includes(preferences.snooze) &&
		Array.isArray(preferences.recentTimes) &&
		preferences.recentTimes.every((time) => typeof time === 'string' && /^\d{2}:\d{2}$/.test(time))
	);
}

function loadBundledSounds() {
	if (!soundInput) return;

	for (const sound of bundledSounds) {
		const option = document.createElement('option');
		option.value = sound.id;
		option.textContent = sound.label;
		soundInput.append(option);
	}

	if (bundledSounds.length === 0) {
		soundInput.options[0]!.textContent = 'Ajoutez des pistes au site';
		soundInput.options[0]!.disabled = true;
	}
}

function openAudioDatabase() {
	databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(databaseName, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(audioStoreName);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Ouverture de la base audio impossible.'));
		request.onblocked = () => reject(new Error('La base audio est bloquée par un autre onglet.'));
	});

	return databasePromise;
}

async function storeCustomAudio(file: File) {
	const database = await openAudioDatabase();
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction(audioStoreName, 'readwrite');
		transaction.objectStore(audioStoreName).put({ blob: file, name: file.name } satisfies StoredAudio, 'selected');
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('Enregistrement du fichier audio impossible.'));
		transaction.onabort = () => reject(transaction.error ?? new Error('Enregistrement du fichier audio annulé.'));
	});
}

async function readCustomAudio() {
	const database = await openAudioDatabase();
	return new Promise<StoredAudio | undefined>((resolve, reject) => {
		const request = database.transaction(audioStoreName, 'readonly').objectStore(audioStoreName).get('selected');
		request.onsuccess = () => {
			const result: unknown = request.result;
			if (
				!result ||
				typeof result !== 'object' ||
				!('blob' in result) ||
				!(result.blob instanceof Blob) ||
				!('name' in result) ||
				typeof result.name !== 'string'
			) {
				resolve(undefined);
				return;
			}
			resolve({ blob: result.blob, name: result.name });
		};
		request.onerror = () => reject(request.error ?? new Error('Lecture du fichier audio impossible.'));
	});
}

function setSelectedFile(name: string) {
	if (selectedFileLabel) selectedFileLabel.textContent = name;
}

function setAudioSource(source: string) {
	if (!alarmAudio || alarmAudio.src === new URL(source, window.location.href).href) return;
	alarmAudio.src = source;
	alarmAudio.load();
}

function applySoundSelection(value: string) {
	selectedSound = value;
	const sound = bundledSounds.find((track) => track.id === value);
	if (sound) {
		setAudioSource(sound.src);
		return;
	}
	if (value === 'custom' && customAudioUrl) {
		setAudioSource(customAudioUrl);
	}
}

async function loadPreferences() {
	try {
		const stored = localStorage.getItem(storageKey);
		if (stored) {
			const preferences: unknown = JSON.parse(stored);
			if (!isAlarmPreferences(preferences)) {
				setStatus('Les réglages enregistrés ne sont pas valides. Choisissez vos préférences à nouveau.');
				return;
			}

			timeInput!.value = preferences.time;
			volumeInput!.value = String(preferences.volume);
			snoozeInput!.value = String(preferences.snooze);
			recentTimes = preferences.recentTimes.slice(0, 4);
			updateVolumeOutput();
			renderRecentTimes();

			const bundleExists = bundledSounds.some((sound) => sound.id === preferences.sound);
			if (bundleExists) {
				soundInput!.value = preferences.sound;
				applySoundSelection(preferences.sound);
			} else if (preferences.sound === 'custom') {
				const savedAudio = await readCustomAudio();
				if (savedAudio) {
					customAudioUrl = URL.createObjectURL(savedAudio.blob);
					setSelectedFile(savedAudio.name);
					applySoundSelection('custom');
				} else {
					setStatus('Le fichier audio enregistré est introuvable. Choisissez à nouveau votre musique.');
				}
			}
		}
	} catch (error) {
		setStatus('Le fichier audio ou les réglages enregistrés n’ont pas pu être lus sur cet appareil.');
		console.error('Impossible de lire les préférences ou le fichier audio.', error);
	}
}

function savePreferences() {
	try {
		const preferences: AlarmPreferences = {
			time: timeInput!.value,
			sound: selectedSound,
			volume: Number(volumeInput!.value),
			snooze: Number(snoozeInput!.value),
			recentTimes,
		};
		localStorage.setItem(storageKey, JSON.stringify(preferences));
	} catch (error) {
		setStatus('Le navigateur n’a pas pu enregistrer vos réglages sur cet appareil.');
		console.error('Impossible d’enregistrer les préférences du réveil.', error);
	}
}

function updateVolumeOutput() {
	if (volumeOutput && volumeInput) {
		volumeOutput.value = `${volumeInput.value} %`;
		volumeOutput.textContent = `${volumeInput.value} %`;
	}
}

function renderRecentTimes() {
	if (!recentTimesSection || !recentTimesList) return;
	recentTimesList.replaceChildren();
	recentTimesSection.classList.toggle('hidden', recentTimes.length === 0);

	for (const time of recentTimes) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'button button-soft';
		button.textContent = time;
		button.setAttribute('aria-label', `Choisir ${time} parmi les heures récentes`);
		button.addEventListener('click', () => {
			timeInput!.value = time;
			timeInput!.focus();
			savePreferences();
			setStatus(`Heure du réveil réglée sur ${time}.`);
		});
		recentTimesList.append(button);
	}
}

async function playSound(repeat: boolean) {
	if (!alarmAudio || !selectedSound) {
		setStatus('Choisissez une musique intégrée ou importez un fichier audio avant de tester le son.');
		return;
	}

	window.clearTimeout(previewTimeout);
	alarmAudio.pause();
	alarmAudio.currentTime = 0;
	alarmAudio.volume = Number(volumeInput!.value) / 100;
	alarmAudio.loop = repeat;

	try {
		await alarmAudio.play();
		if (!repeat) {
			previewTimeout = window.setTimeout(() => {
				alarmAudio.pause();
				alarmAudio.currentTime = 0;
			}, 15_000);
		}
	} catch (error) {
		setStatus('La musique ne peut pas être lue. Vérifiez le format du fichier et les réglages audio de votre navigateur.');
		console.error('Impossible de lire la musique sélectionnée.', error);
	}
}

function formatCountdown(milliseconds: number) {
	const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function updateCountdown() {
	if (targetTime === null) return;
	const remaining = targetTime - Date.now();

	if (remaining <= 0) {
		startRinging();
		return;
	}

	const countdown = formatCountdown(remaining);
	if (countdownValue) {
		countdownValue.textContent = countdown;
		countdownValue.dateTime = `PT${Math.ceil(remaining / 1000)}S`;
	}
	document.title = `${countdown} — réveil en ligne`;
}

function clearTimers() {
	window.clearInterval(countdownInterval);
	window.clearTimeout(previewTimeout);
	countdownInterval = undefined;
	previewTimeout = undefined;
}

function silenceSound() {
	window.clearTimeout(previewTimeout);
	previewTimeout = undefined;
	if (!alarmAudio) return;
	alarmAudio.pause();
	alarmAudio.loop = false;
	if (Number.isFinite(alarmAudio.duration)) alarmAudio.currentTime = 0;
}

async function requestWakeLock() {
	if (wakeLock) return;
	if (!('wakeLock' in navigator)) {
		setStatus('Votre réveil est programmé. Gardez l’appareil éveillé pour que la sonnerie fonctionne.');
		return;
	}

	try {
		wakeLock = await navigator.wakeLock.request('screen');
		wakeLock.addEventListener('release', () => {
			wakeLock = null;
		});
	} catch (error) {
		setStatus('Votre réveil est programmé, mais le navigateur n’a pas pu garder l’écran éveillé.');
		console.error('Impossible de garder l’écran éveillé.', error);
	}
}

async function releaseWakeLock() {
	if (!wakeLock) return;
	try {
		await wakeLock.release();
		wakeLock = null;
	} catch (error) {
		setStatus('Le réveil est arrêté, mais le maintien de l’écran éveillé n’a pas pu être libéré.');
		console.error('Impossible de libérer le maintien de l’écran éveillé.', error);
	}
}

function setAlarm(date: Date) {
	clearTimers();
	silenceSound();
	ringing = false;
	targetTime = date.getTime();
	ringingPanel!.hidden = true;
	countdownPanel!.hidden = false;
	startLabel!.textContent = 'Modifier le réveil';
	alarmTarget!.textContent = `Sonnerie prévue à ${formatTime(date)}${date.toDateString() !== new Date().toDateString() ? ' demain' : ''}`;
	snoozeLabel!.textContent = `${snoozeInput!.value} min`;
	setStatus('Réveil programmé. Gardez cet onglet ouvert et vérifiez le volume de votre appareil.');
	void requestWakeLock();
	updateCountdown();
	countdownInterval = window.setInterval(updateCountdown, 250);
	document.title = `Réveil prévu à ${formatTime(date)} — réveil en ligne`;
}

function startRinging() {
	if (ringing || targetTime === null) return;
	ringing = true;
	targetTime = null;
	window.clearInterval(countdownInterval);
	countdownInterval = undefined;
	countdownPanel!.hidden = true;
	ringingPanel!.hidden = false;
	setStatus('Votre réveil sonne.');
	document.title = 'Votre réveil sonne — réveil en ligne';
	void playSound(true);
	document.querySelector<HTMLButtonElement>('#stop-alarm')?.focus();
}

function stopAlarm() {
	clearTimers();
	silenceSound();
	targetTime = null;
	ringing = false;
	countdownPanel!.hidden = true;
	ringingPanel!.hidden = true;
	startLabel!.textContent = 'Démarrer le réveil';
	document.title = 'Réveil en ligne — un réveil simple et gratuit';
	setStatus('Réveil arrêté. Vous pouvez en programmer un autre.');
	void releaseWakeLock();
}

function snoozeAlarm() {
	const snoozeMinutes = Number(snoozeInput!.value);
	silenceSound();
	ringing = false;
	setAlarm(new Date(Date.now() + snoozeMinutes * 60_000));
	setStatus(`Réveil répété dans ${snoozeMinutes} minutes.`);
	document.querySelector<HTMLButtonElement>('#cancel-alarm')?.focus();
}

function setFromMinutes(minutes: number) {
	const date = new Date(Date.now() + minutes * 60_000);
	writeTimeToInput(date);
	setStatus(`Heure réglée sur ${formatTime(date)}. Démarrez le réveil pour lancer le compte à rebours.`);
}

alarmForm?.addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!alarmForm.reportValidity()) return;
	if (!selectedSound) {
		setStatus('Choisissez une musique intégrée ou importez votre fichier audio avant de démarrer le réveil.');
		return;
	}

	const [hours, minutes] = timeInput!.value.split(':').map(Number);
	const now = new Date();
	const date = new Date(now);
	date.setHours(hours, minutes, 0, 0);
	if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);

	recentTimes = [timeInput!.value, ...recentTimes.filter((time) => time !== timeInput!.value)].slice(0, 4);
	renderRecentTimes();
	savePreferences();
	setAlarm(date);
});

document.querySelectorAll<HTMLButtonElement>('[data-minutes]').forEach((button) => {
	button.addEventListener('click', () => setFromMinutes(Number(button.dataset.minutes)));
});

document.querySelector<HTMLButtonElement>('#preview-sound')?.addEventListener('click', () => {
	void playSound(false);
});

soundInput?.addEventListener('change', () => {
	applySoundSelection(soundInput.value);
	if (soundInput.value) setSelectedFile('Une musique intégrée est sélectionnée.');
	savePreferences();
});

audioFileInput?.addEventListener('change', async () => {
	const file = audioFileInput.files?.[0];
	if (!file) return;
	if (!file.type.startsWith('audio/')) {
		setStatus('Ce fichier ne semble pas être un fichier audio. Choisissez un fichier audio pris en charge.');
		audioFileInput.value = '';
		return;
	}

	try {
		await storeCustomAudio(file);
		if (customAudioUrl) URL.revokeObjectURL(customAudioUrl);
		customAudioUrl = URL.createObjectURL(file);
		setSelectedFile(file.name);
		soundInput!.value = '';
		applySoundSelection('custom');
		savePreferences();
		setStatus('Votre musique est enregistrée sur cet appareil. Écoutez-la pour vérifier le son.');
	} catch (error) {
		setStatus('Le fichier audio n’a pas pu être enregistré dans ce navigateur. Essayez un fichier plus petit ou vérifiez l’espace disponible.');
		console.error('Impossible d’enregistrer le fichier audio importé.', error);
	}
});

document.querySelector<HTMLButtonElement>('#cancel-alarm')?.addEventListener('click', stopAlarm);
document.querySelector<HTMLButtonElement>('#stop-alarm')?.addEventListener('click', stopAlarm);
document.querySelector<HTMLButtonElement>('#snooze-alarm')?.addEventListener('click', snoozeAlarm);

document.querySelector<HTMLButtonElement>('#fullscreen-toggle')?.addEventListener('click', async () => {
	try {
		if (document.fullscreenElement) {
			await document.exitFullscreen();
		} else {
			await alarmCard!.requestFullscreen();
		}
	} catch (error) {
		setStatus('Le plein écran n’a pas pu être activé dans ce navigateur.');
		console.error('Impossible de changer le mode plein écran.', error);
	}
});

document.querySelector<HTMLButtonElement>('#night-toggle')?.addEventListener('click', (event) => {
	const button = event.currentTarget as HTMLButtonElement;
	const enabled = button.getAttribute('aria-pressed') !== 'true';
	button.setAttribute('aria-pressed', String(enabled));
	button.textContent = enabled ? 'Quitter l’affichage nuit' : 'Affichage nuit';
	alarmCard?.classList.toggle('night-display', enabled);
});

volumeInput?.addEventListener('input', () => {
	updateVolumeOutput();
	if (alarmAudio) alarmAudio.volume = Number(volumeInput.value) / 100;
	savePreferences();
});

snoozeInput?.addEventListener('change', () => {
	snoozeLabel!.textContent = `${snoozeInput.value} min`;
	savePreferences();
});
timeInput?.addEventListener('change', savePreferences);

updateClock();
window.setInterval(updateClock, 1000);
writeTimeToInput(new Date(Date.now() + 30 * 60_000));
loadBundledSounds();
alarmAudio?.addEventListener('error', () => {
	setStatus('La musique ne peut pas être lue. Vérifiez le format audio ou choisissez un autre fichier.');
	console.error('Erreur de lecture audio.', alarmAudio.error);
});
void loadPreferences();
updateVolumeOutput();
snoozeLabel!.textContent = `${snoozeInput!.value} min`;
