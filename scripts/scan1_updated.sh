#!/bin/sh

# PCI DSS Compliance Scanner for GCP HTTP Request Logs
# Scans for unmasked credit card numbers, CVC codes, authorization tokens,
# and other sensitive data in GCP-style JSON payload logs.
#
# Log format expected:
#   [SSCI] - <id> * Server has received a request ID: <id> Address: <url>
#   Http-Method: POST Headers: {...} Payload: {...} <id> * Server request end

generallogfilenamepattern=""

printUsageAndExit()
{
		echo "================================="
		echo "NO VALID ARGUMENTS WERE PROVIDED"
		echo "================================="
		echo ""
		echo "USAGE: $0 <email> <numberoffiles> <logFileDirectory>"
		echo "USAGE: $0 <email> -logfile <logfilename> <logFileDirectory>"
		exit
}

checkCommandLineArguments()
{
	echo 'checkCommandLineArguments'
	if [ "$1" != "" ]; then
		email=$1
		logfile=$generallogfilenamepattern
	else
		printUsageAndExit
	fi

	if [ "$2" != "" ]; then
		numoffiles=$2
		if [ "$numoffiles" = "-logfile" ]; then
			if [ "$3" != "" ]; then
				logfile=$3
				logFileDirectory=$4
				numoffiles=1
			else
				printUsageAndExit
			fi
		else
			if [[ $numoffiles == [0-9]* ]]; then
				if [ "$numoffiles" -le 0 ]; then
					echo "Number of files to scan must be greater than 0"
					exit
				else
					numoffiles=$2
					logFileDirectory=$3
				fi
			else
				printUsageAndExit
			fi
		fi
	else
		numoffiles=""
	fi
}

getUnmaskedCreditCardsReport()
{

# --- PCI patterns for GCP JSON payload logs ---

# Unmasked credit card number in JSON: "number":"4111111111111111" (13-19 digits, not masked with X)
# A properly masked number looks like: "number":"XXXXXXXXXX1111" or "number":"XXXXXXXXXXXX3335"
# Unmasked means the full number is visible (all digits, no X masking in first 6+ positions)
cc_json_full="\"number\"[[:space:]]*:[[:space:]]*\"[0-9]{13,19}\""

# Partially unmasked card number: starts with digits (not X) and has 6+ consecutive digits
cc_json_partial="\"number\"[[:space:]]*:[[:space:]]*\"[0-9]{6}[0-9X]*\""

# Unmasked CVC in JSON: "cvc":"123" or "cvc":"1234" (actual digits, not masked as XXX)
cvc_json="\"cvc\"[[:space:]]*:[[:space:]]*\"[0-9]{3,4}\""

# Unmasked authorization header (not masked as XXXXXXXX)
auth_unmasked="authorization=\\[[^X][^\\]]{8,}\\]"

# Exposed login tokens (lalogintoken with actual token value)
login_token="lalogintoken=T1[A-Za-z0-9+/=]{20,}"

# Unmasked phone number in JSON: "number":"1234567890" (7+ digits, no X masking)
phone_unmasked="\"number\"[[:space:]]*:[[:space:]]*\"[0-9]{7,}\""

# Password in JSON payload
pw_json="\"[pP]assword\"[[:space:]]*:[[:space:]]*\"[^X][^\"]+\""

# Unmasked expiration date is not a PCI concern if card number is masked,
# but flag it if found alongside unmasked numbers
# "expirationDate":"2032-03" - this alone is not a violation but tracked for context

# --- Legacy patterns (kept for backward compatibility with mixed log formats) ---
cc1="\*[A-Z]*[A-Z][A-Z][0-9][0-9][0-9][0-9][0-9][0-9]*"
cc_legacy="\/[C][C][A-Z][A-Z]*[0-9][0-9][0-9][0-9][0-9][0-9]*[E][X][P]"
cvc_security="[sS]ecurity[cC]ode\"[[:space:]]*:[[:space:]]*\"[0-9]{3,4}\""

fcounter=0

for f in $(ls -lt "$logFileDirectory" | grep ^- | awk '{print $9}' | grep "$logfile"); do
	echo "Scanning file: $f"

	awk 'BEGIN {
		cc_counter=0;
		cvc_counter=0;
		auth_counter=0;
		token_counter=0;
		phone_counter=0;
		pw_counter=0;
		i=0
	}
	{
		i=i+1;

		# Skip very long lines to avoid performance issues
		if(length($0) > 200000) next;

		# --- Check for unmasked credit card numbers in JSON payloads ---
		# Full unmasked PAN: "number" : "4111111111111111" (13-19 pure digits)
		if(match($0, /"number"[[:space:]]*:[[:space:]]*"[0-9]{13,19}"/)) {
			cc_counter++;
			printf i " ==> UNMASKED CREDIT CARD NUMBER: " substr($0, RSTART, RLENGTH) "\n";
		}

		# Partially unmasked PAN: starts with 6+ digits (first 6 should be masked too per PCI)
		# But skip properly masked ones like XXXXXXXXXX1111
		if(match($0, /"number"[[:space:]]*:[[:space:]]*"[0-9]{6,}[0-9X]*"/)) {
			# Extract the value to check if it is truly unmasked
			val = substr($0, RSTART, RLENGTH);
			if(val !~ /X/) {
				cc_counter++;
				printf i " ==> PARTIALLY UNMASKED CARD NUMBER: " val "\n";
			}
		}

		# --- Check for unmasked CVC/CVV codes ---
		# "cvc" : "123" (3-4 pure digits means unmasked)
		if(match($0, /"cvc"[[:space:]]*:[[:space:]]*"[0-9]{3,4}"/)) {
			cvc_counter++;
			printf i " ==> UNMASKED CVC/CVV: " substr($0, RSTART, RLENGTH) "\n";
		}

		# securityCode in JSON
		if(match($0, /[sS]ecurity[cC]ode"[[:space:]]*:[[:space:]]*"[0-9]{3,4}"/)) {
			cvc_counter++;
			printf i " ==> UNMASKED SECURITY CODE: " substr($0, RSTART, RLENGTH) "\n";
		}

		# --- Check for unmasked authorization headers ---
		# Properly masked: authorization=[XXXXXXXX]
		# Unmasked: authorization=[Bearer eyJ...] or authorization=[Basic ...]
		if(match($0, /authorization=\[[^X\]]{9,}\]/)) {
			auth_counter++;
			matched = substr($0, RSTART, RLENGTH);
			# Truncate long tokens for display
			if(length(matched) > 80) matched = substr(matched, 1, 80) "...";
			printf i " ==> UNMASKED AUTHORIZATION: " matched "\n";
		}

		# --- Check for exposed login tokens ---
		if(match($0, /lalogintoken=T1[A-Za-z0-9+\/=]{20,}/)) {
			token_counter++;
			matched = substr($0, RSTART, RLENGTH);
			if(length(matched) > 80) matched = substr(matched, 1, 80) "...";
			printf i " ==> EXPOSED LOGIN TOKEN: " matched "\n";
		}

		# --- Check for unmasked phone numbers in payment JSON ---
		# "number":"9990100" (in phone context, 7+ pure digits)
		# Must distinguish from card "number" field - check for phone context
		if(match($0, /"phone".*"number"[[:space:]]*:[[:space:]]*"[0-9]{7,}"/)) {
			phone_counter++;
			printf i " ==> UNMASKED PHONE NUMBER in payment data\n";
		}

		# --- Check for passwords in clear text ---
		if(match($0, /[pP]assword"[[:space:]]*:[[:space:]]*"[^X"][^"]+"/)) {
			pw_counter++;
			printf i " ==> UNMASKED PASSWORD: " substr($0, RSTART, RLENGTH) "\n";
		}

		# --- Legacy GDS patterns ---
		if(match($0, /\*[A-Z]*[A-Z][A-Z][0-9][0-9][0-9][0-9][0-9][0-9]*/)) {
			cc_counter++;
			printf i " ==> LEGACY UNMASKED CC: " substr($0, RSTART, RLENGTH) "\n";
		}
		if(match($0, /\/CC[A-Z][A-Z]*[0-9][0-9][0-9][0-9][0-9][0-9]*EXP/)) {
			cc_counter++;
			printf i " ==> LEGACY UNMASKED CC (EXP format): " substr($0, RSTART, RLENGTH) "\n";
		}
	}
	END {
		print "======================================================================";
		print "PCI SCAN SUMMARY";
		print "======================================================================";
		print cc_counter    " UNMASKED CREDIT CARD NUMBERS FOUND";
		print cvc_counter   " UNMASKED CVC/CVV CODES FOUND";
		print auth_counter  " UNMASKED AUTHORIZATION HEADERS FOUND";
		print token_counter " EXPOSED LOGIN TOKENS FOUND";
		print phone_counter " UNMASKED PHONE NUMBERS FOUND";
		print pw_counter    " UNMASKED PASSWORDS FOUND";
		print "======================================================================";
		total = cc_counter + cvc_counter + auth_counter + token_counter + phone_counter + pw_counter;
		if(total > 0) {
			print "*** PCI COMPLIANCE VIOLATION: " total " total findings ***";
		} else {
			print "PASS: No unmasked PCI-sensitive data detected.";
		}
		print "======================================================================";
	}' "$logFileDirectory/$f"

	echo " "
	echo "Finished Scanning file: $f"
	echo "==============================================================================================="
	fcounter=$((fcounter+1))
	if [ "$numoffiles" != "" ] && [ "$fcounter" -ge "$numoffiles" ]; then
		break
	fi

done

}
checkCommandLineArguments $*
getUnmaskedCreditCardsReport


