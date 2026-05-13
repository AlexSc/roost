# Pushover (https://pushover.net/) bridge for weechat.
#
# Sibling to notification_center.py. Same trigger logic and setting names
# (channels, show_highlights, show_private_message, show_message_text,
# enabled, ignore_old_messages, ignore_current_buffer_messages) so behavior
# is mechanically identical — only the delivery transport differs
# (terminal-notifier vs Pushover HTTPS).
#
# Setup:
#   /set plugins.var.python.pushover.user_key   <your user key>
#   /set plugins.var.python.pushover.app_token  <your application token>
#
# HTTP is dispatched via weechat.hook_process_hashtable with a `url:` prefix,
# so the request runs in a forked child and weechat's main loop never blocks.

import datetime
import urllib.parse

import weechat


SCRIPT_NAME = 'pushover'
SCRIPT_AUTHOR = 'roost <noreply@anthropic.com>'
SCRIPT_VERSION = '0.1.0'
SCRIPT_LICENSE = 'MIT'
SCRIPT_DESC = 'Send weechat highlights and private messages to Pushover.'

weechat.register(SCRIPT_NAME, SCRIPT_AUTHOR, SCRIPT_VERSION, SCRIPT_LICENSE, SCRIPT_DESC, '', '')


DEFAULT_OPTIONS = {
	'user_key': '',
	'app_token': '',
	'enabled': 'on',
	'show_highlights': 'on',
	'show_private_message': 'on',
	'show_message_text': 'on',
	'channels': '',
	'ignore_old_messages': 'off',
	'ignore_current_buffer_messages': 'off',
	'max_body_chars': '140',
	'priority': '0',
	'sound': '',
	'device': '',
	'http_timeout_seconds': '10',
	'debug': 'off',
}

for key, val in DEFAULT_OPTIONS.items():
	if not weechat.config_is_set_plugin(key):
		weechat.config_set_plugin(key, val)

if not weechat.config_get_plugin('user_key') or not weechat.config_get_plugin('app_token'):
	weechat.prnt('', '[pushover] not configured — set plugins.var.python.pushover.user_key and .app_token')


def _opt(name):
	return weechat.config_get_plugin(name)

def _opt_int(name, default):
	try:
		return int(_opt(name))
	except ValueError:
		return default

def _truncate(s, n):
	return s if len(s) <= n else s[:n - 3].rstrip() + '...'

def _post_callback(data, command, return_code, out, err):
	if _opt('debug') == 'on':
		weechat.prnt('', '[pushover] rc=%d out=%r err=%r' % (return_code, out[:200], err[:200]))
	if return_code != 0 and return_code != weechat.WEECHAT_HOOK_PROCESS_RUNNING:
		weechat.prnt('', '[pushover] http rc=%d err=%s' % (return_code, err[:200] if err else ''))
	return weechat.WEECHAT_RC_OK

def _send(title, body):
	user_key = _opt('user_key')
	app_token = _opt('app_token')
	if not user_key or not app_token:
		return
	body = _truncate(body, _opt_int('max_body_chars', 140))
	form = {
		'token': app_token,
		'user': user_key,
		'title': title,
		'message': body,
	}
	priority = _opt('priority')
	if priority and priority != '0':
		form['priority'] = priority
	sound = _opt('sound')
	if sound:
		form['sound'] = sound
	device = _opt('device')
	if device:
		form['device'] = device
	weechat.hook_process_hashtable(
		'url:https://api.pushover.net/1/messages.json',
		{'postfields': urllib.parse.urlencode(form)},
		_opt_int('http_timeout_seconds', 10) * 1000,
		'_post_callback',
		'',
	)

weechat.hook_print('', 'irc_privmsg', '', 1, 'notify', '')

def notify(data, buffer, date, tags, displayed, highlight, prefix, message):
	if _opt('enabled') != 'on':
		return weechat.WEECHAT_RC_OK
	if not _opt('user_key') or not _opt('app_token'):
		return weechat.WEECHAT_RC_OK

	own_nick = weechat.buffer_get_string(buffer, 'localvar_nick')
	if prefix == own_nick or prefix == ('@%s' % own_nick):
		return weechat.WEECHAT_RC_OK

	if _opt('ignore_current_buffer_messages') == 'on' and buffer == weechat.current_buffer():
		return weechat.WEECHAT_RC_OK

	if _opt('ignore_old_messages') == 'on':
		message_time = datetime.datetime.utcfromtimestamp(int(date))
		if (datetime.datetime.utcnow() - message_time).seconds > 5:
			return weechat.WEECHAT_RC_OK

	show_text = _opt('show_message_text') == 'on'

	channels_setting = _opt('channels').strip()
	notify_all = channels_setting == '*'
	channel_allow_list = [] if (not channels_setting or notify_all) else [c.strip() for c in channels_setting.split(',')]
	channel = weechat.buffer_get_string(buffer, 'localvar_channel')

	if notify_all or channel in channel_allow_list:
		title = '%s %s' % (prefix, channel)
		body = message if show_text else 'In %s by %s' % (channel, prefix)
		_send(title, body)
	elif _opt('show_highlights') == 'on' and int(highlight):
		title = '%s %s' % (prefix, channel) if show_text else 'Highlighted Message'
		body = message if show_text else 'In %s by %s' % (channel, prefix)
		_send(title, body)
	elif _opt('show_private_message') == 'on' and 'irc_privmsg' in tags and 'notify_private' in tags:
		title = '%s [private]' % prefix if show_text else 'Private Message'
		body = message if show_text else 'From %s' % prefix
		_send(title, body)
	return weechat.WEECHAT_RC_OK
