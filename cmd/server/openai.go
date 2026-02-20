package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
)

const openAIURL = "https://api.openai.com/v1/chat/completions"

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []message `json:"messages"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error,omitempty"`
}

func callOpenAI(userMessage string) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", nil
	}

	reqBody := chatRequest{
		Model: "gpt-4o-mini",
		Messages: []message{
			{Role: "system", Content: "Ты — помощник МАФ (Можайский Александр Фёдорович). Отвечай кратко и по делу на русском."},
			{Role: "user", Content: userMessage},
		},
	}
	body, _ := json.Marshal(reqBody)

	req, err := http.NewRequest(http.MethodPost, openAIURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	var out chatResponse
	_ = json.Unmarshal(respBody, &out)

	if resp.StatusCode != http.StatusOK {
		msg := string(respBody)
		if out.Error != nil && out.Error.Message != "" {
			msg = out.Error.Message
		}
		return "", &openAIError{code: resp.StatusCode, msg: msg}
	}
	if len(out.Choices) == 0 {
		return "", nil
	}
	return out.Choices[0].Message.Content, nil
}

type openAIError struct {
	code int
	msg  string
}

func (e *openAIError) Error() string {
	return e.msg
}
